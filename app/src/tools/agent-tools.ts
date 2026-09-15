/**
 * Agent 的受控设备工具：模型能"真的调用"的唯一设备入口。
 *
 * 运行形态：不是进程内注册的自定义工具（penguin-core 的自定义工具只能来自 tools.builtin 工厂表），
 * 而是本项目自带的一个 stdio MCP 服务（src/tools/wrapper-server.ts）。Agent State 的
 * tools.mcpServers 指向它，模型看到的是 `mcp__recovery-control__*` 四个工具，服务进程里跑的就是这里。
 *
 * 三层边界：
 * 1. 模型只能给"动作意图"：四个工具的入参 schema 都是空对象，device_id / expected_revision /
 *    request_id 全由后端补全，模型无法指定设备、版本或请求号，也改不了执行模式。
 * 2. 本文件只做参数补全与转发，真正的核对与判定在 recovery.ts（先查最新状态 → 核对前置条件 →
 *    带 revision/request_id 请求 → 限时读回 → 按阶段判定）。
 * 3. 案例由服务进程的 cwd 反查（Session 的 workspaceDir = 案例目录）。查不到就如实报错，
 *    绝不猜一个案例、也绝不退回到"哪个案例都行"。
 */
import fs from "node:fs";
import path from "node:path";
import { caseDir, getCase, hasThermalContext, listCases } from "../case/store.ts";
import { queryStatus, runRecovery, type RecoveryAction } from "./recovery.ts";
import type { InterfaceId } from "./registry.ts";

export type AgentToolName = "get_device_status" | "get_cooling_status" | "resume_conveyor" | "start_cooling";

/** 受控设备工具服务名：模型看到的是 mcp__recovery-control__<tool>（setup-agent.ts 写入同一名字）。 */
export const MCP_SERVER_NAME = "recovery-control";

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/** 空入参：模型只能表达"调用哪个动作"，不能带任何设备、版本、请求号或速度。 */
const NO_ARGUMENTS = { type: "object", additionalProperties: false, properties: {} } as const;

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "get_device_status",
    description:
      "读取该设备最新的可信状态（供电、驱动、运行反馈、出口计数、许可与版本 revision）。上传资料里的快照不能代替它。只读，不改变设备。",
    inputSchema: { ...NO_ARGUMENTS },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_cooling_status",
    description:
      "读取同一设备最新的温度、风机、温控暂停与散热/运行许可，使用与供电查询相同的状态版本。只读，不改变设备。",
    inputSchema: { ...NO_ARGUMENTS },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "resume_conveyor",
    description:
      "请求后端执行批准的输送恢复流程。后端会在执行点前重新查询最新状态、核对前置条件，并附加 expected_revision 与唯一的 request_id；同一动作重试不会第二次执行。不接通电源、不解除保护、不接受任意速度、不返回编造的成功。",
    inputSchema: { ...NO_ARGUMENTS },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "start_cooling",
    description:
      "请求后端开启批准的散热模式。后端同样先查询、再核对、并补齐 expected_revision 与 request_id。不启动输送、不修改温度或保护阈值。",
    inputSchema: { ...NO_ARGUMENTS },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

export function isAgentToolName(name: string): name is AgentToolName {
  return AGENT_TOOLS.some((t) => t.name === name);
}

/**
 * 规范化到"同一目录的全部等价写法"：解析后的绝对路径 + 真实路径。
 * macOS 的 /var 与 /private/var、以及软链接都会让同一个目录出现两种写法
 * （子进程 process.cwd() 返回真实路径，而配置里给的可能是软链接路径）。
 */
function sameDirCandidates(p: string): string[] {
  const resolved = path.resolve(p);
  const out = [resolved];
  try {
    const real = fs.realpathSync(resolved);
    if (!out.includes(real)) out.push(real);
  } catch {
    // 目录不存在时只留绝对路径
  }
  return out;
}

/** Session 的 workspaceDir 就是案例目录；用目录反查案例，不做任何猜测。 */
export function resolveCaseId(cwd: string): string | null {
  const target = sameDirCandidates(cwd);
  for (const meta of listCases()) {
    const candidates = sameDirCandidates(caseDir(meta.caseId));
    if (target.some((t) => candidates.includes(t))) return meta.caseId;
  }
  return null;
}

const QUERY_INTERFACE: Record<"get_device_status" | "get_cooling_status", InterfaceId> = {
  get_device_status: "power-control",
  get_cooling_status: "cooling-control",
};

const ACTION_OF: Record<"resume_conveyor" | "start_cooling", RecoveryAction> = {
  resume_conveyor: "resume_conveyor",
  start_cooling: "start_cooling",
};

export interface AgentToolCall {
  /** 工具调用是否取得了可用的结果（不是"动作一定成功"）。 */
  ok: boolean;
  payload: Record<string, unknown>;
}

/**
 * 执行一次工具调用。返回的 payload 原样交给模型：结论、原因码、限时读回的预算与实际用时、
 * 是否幂等重放都在里面 —— 模型据此判断下一步，而不是从一句话里猜。
 */
export async function callAgentTool(name: AgentToolName, cwd: string): Promise<AgentToolCall> {
  const caseId = resolveCaseId(cwd);
  if (!caseId) {
    return {
      ok: false,
      payload: {
        error: "CASE_NOT_RESOLVED",
        tool: name,
        cwd: path.resolve(cwd),
        message:
          "无法从工作目录反查案例：当前工作目录不是任何已载入案例的目录。没有查询、也没有执行任何动作。",
      },
    };
  }

  if (name === "get_device_status" || name === "get_cooling_status") {
    const result = await queryStatus(caseId, QUERY_INTERFACE[name], "agent");
    return {
      ok: result.ok,
      payload: {
        case_id: caseId,
        interface_id: result.interface_id,
        tool: result.tool,
        reason_code: result.reason_code,
        message: result.message,
        freshness: result.freshness,
        state: result.state,
      },
    };
  }

  const action = ACTION_OF[name];
  const view = getCase(caseId);
  const outcome = await runRecovery(caseId, action, { hasThermalContext: hasThermalContext(view), actor: "agent" });
  const ok = outcome.attempted && outcome.status !== "failed" && outcome.status !== "unknown";
  return {
    ok,
    payload: {
      case_id: caseId,
      action,
      decision: outcome.decision,
      // attempted=false 表示后端在请求动作前就挡住了（未发出写），不是"动作失败"。
      attempted: outcome.attempted,
      status: outcome.status,
      reason_code: outcome.reason_code,
      summary: outcome.summary,
      replayed: outcome.replayed,
      // 重放时 reason_code 是接口返回的原结果（原样保留），所以另外明说"这次没有第二次执行"。
      replay_note: outcome.replayed
        ? "同一请求号的重试：接口按 request_id 幂等返回上一次的原结果，本次没有第二次执行动作。"
        : null,
      readback: outcome.readback,
      operations: outcome.operations,
      latest_state: outcome.latest_state,
      preconditions: outcome.preconditions,
      note: "受理不等于执行完成，更不等于产出恢复；以 status / readback / latest_state 为准。",
    },
  };
}
