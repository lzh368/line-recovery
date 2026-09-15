/**
 * 嵌入式 Agent：产线恢复助手的诊断环节。
 *
 * 它读工作目录里的上传资料，产出"历史异常判断 + 证据 + 恢复计划"；
 * 同时它带着本应用自带的受控设备工具（mcp__recovery-control__*，见 src/tools/agent-tools.ts）：
 * 模型的每次工具调用都要先过这里的 approve（只放行案例内 read_file 与这四个受控工具），
 * 工具进程再由 recovery.ts 走"先查 → 核对 → 带 revision/request_id 请求 → 限时读回"的固定顺序。
 * 模型仍然不能自己决定执行什么：报告里的 operations / latest_state 只取自这条工具轨迹。
 */
import { createAgent, isEventMessage, isModelMessage, userText, type Agent } from "@prismshadow/penguin-core";
import { DATA_ROOT, ENV_FILE } from "../paths.ts";
import type { Facts } from "../case/facts.ts";
import type { ParsedCase } from "../case/parse.ts";
import { MCP_SERVER_NAME, isAgentToolName } from "../tools/agent-tools.ts";
import { buildPrompt } from "./prompt.ts";

export class AnalysisError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 模型：默认 DeepSeek V4.1 Flash（厂商目录里的裸名 `deepseek-flash`，provider `deepseek`，官方端点）。
 * 三项都在 app/.env 里显式写着（LR_MODEL_PROVIDER / LR_MODEL_ID / DEEPSEEK_BASE_URL），
 * 那里改了这里就跟着变，而不是躺在注释里骗人。
 * createSession 每次都显式带上 provider / modelId / baseUrl，不受 Agent 数据根里 Project 默认模型影响。
 */
export const DEFAULT_MODEL_PROVIDER = "deepseek";
export const DEFAULT_MODEL_ID = "deepseek-flash";
export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com";

export function modelProvider(): string {
  return process.env.LR_MODEL_PROVIDER?.trim() || DEFAULT_MODEL_PROVIDER;
}

export function modelId(): string {
  return process.env.LR_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
}

/**
 * 实际使用的端点：DEEPSEEK_BASE_URL 覆盖，否则官方端点。
 * 每次显式传给 createSession —— 否则 Agent 数据根里 Project 的模型条目会把端点定死，
 * 让 .env 里的这一行看起来生效、其实不起作用（已实测：改前改端点无效，改后立即生效）。
 */
export function effectiveBaseUrl(): string {
  return process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL;
}

/** 密钥环境变量名：按 provider 推导（deepseek → DEEPSEEK_API_KEY），与模型 SDK 的取法一致。 */
export function modelKeyEnv(): string {
  return `${modelProvider().toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** 环境里是否有非空密钥。只判断"有没有"，不读取、不记录任何密钥内容。 */
export function hasModelKey(): boolean {
  return Boolean(process.env[modelKeyEnv()]?.trim());
}

/** 没读到密钥时的统一说明：告诉部署方填哪个文件的哪一行。 */
function missingKeyMessage(): string {
  return `没有读到 ${modelKeyEnv()}：请在 ${ENV_FILE} 里填写官方 API Key（见 app/README.md），或在启动前导出同名环境变量。`;
}

export interface AgentDiagnosis {
  diagnosis: Record<string, unknown>;
  recovery_plan: {
    decision: string;
    preferred_action: string | null;
    reason: string;
  };
  limitations: string[];
}

export type AnalysisEvent =
  | { type: "status"; message: string }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; state: "start" | "done" | "deny"; detail?: string }
  | { type: "error"; code: string; message: string };

/** 工具返回是一段 JSON 文本；只取结论行给前端，不把整段结果塞进事件流。 */
function summarizeToolOutput(output: string): string {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const code = typeof parsed.reason_code === "string" ? parsed.reason_code : typeof parsed.status === "string" ? parsed.status : "";
    const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.summary === "string" ? parsed.summary : "";
    const text = [code, message].filter(Boolean).join("：") || trimmed;
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  }
}

let agentPromise: Promise<Agent> | null = null;

function getAgent(): Promise<Agent> {
  if (!agentPromise) {
    // 数据根固定在项目内：绝不使用或回落到用户全局 ~/.penguin。
    agentPromise = createAgent({ root: DATA_ROOT });
  }
  return agentPromise;
}

/**
 * 只允许两类调用：读案例工作目录内的文件，以及调用本应用自带的受控设备工具
 * （src/tools/wrapper-server.ts 暴露的 mcp__recovery-control__*）。
 * 其余一律拒绝 —— 设备、版本与请求号由后端补全，模型不能经入参指定。
 */
function approveReadOnly(workspaceDir: string) {
  return async (toolCall: { payload: { name: string; arguments: string } }) => {
    const { name, arguments: rawArgs } = toolCall.payload;
    if (isControlledTool(name)) return "allow" as const;
    if (name !== "read_file") return "deny" as const;
    try {
      const args = JSON.parse(rawArgs || "{}") as { file_path?: string };
      const target = String(args.file_path ?? "");
      if (!target) return "deny" as const;
      const path = await import("node:path");
      const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspaceDir, target);
      return resolved === workspaceDir || resolved.startsWith(workspaceDir + path.sep)
        ? ("allow" as const)
        : ("deny" as const);
    } catch {
      return "deny" as const;
    }
  };
}

/** 受控设备工具在模型侧的名字：mcp__recovery-control__<tool>。 */
export function isControlledTool(name: string): boolean {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(name);
  if (!match) return false;
  return match[1] === MCP_SERVER_NAME && isAgentToolName(match[2]!);
}

/** 工具轨迹里显示的名字：把 MCP 前缀还原成工具本名。 */
export function toolDisplayName(name: string): string {
  return isControlledTool(name) ? name.slice(`mcp__${MCP_SERVER_NAME}__`.length) : name;
}

/** 从模型输出里取第一个完整 JSON 对象（容忍代码围栏与前后说明文字）。 */
export function extractJson(text: string): unknown {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("{");
  if (start < 0) throw new AnalysisError("NO_JSON", "模型输出里没有 JSON 对象");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < withoutFences.length; i += 1) {
    const ch = withoutFences[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = withoutFences.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (error) {
          throw new AnalysisError("BAD_JSON", `模型输出的 JSON 无法解析：${(error as Error).message}`, slice.slice(0, 2000));
        }
      }
    }
  }
  throw new AnalysisError("BAD_JSON", "模型输出的 JSON 不完整", withoutFences.slice(start, start + 2000));
}

export function normalizeDiagnosis(raw: unknown): AgentDiagnosis {
  if (!raw || typeof raw !== "object") throw new AnalysisError("BAD_SHAPE", "模型输出不是 JSON 对象");
  const obj = raw as Record<string, any>;
  const diagnosis = obj.diagnosis ?? obj; // 容忍模型直接给出 diagnosis 字段内容
  const plan = obj.recovery_plan ?? {};
  const limitations = Array.isArray(obj.limitations) ? obj.limitations.map(String) : [];
  return {
    diagnosis: diagnosis as Record<string, unknown>,
    recovery_plan: {
      decision: String(plan.decision ?? "insufficient_evidence"),
      preferred_action: plan.preferred_action ? String(plan.preferred_action) : null,
      reason: String(plan.reason ?? ""),
    },
    limitations,
  };
}

/** 跑一次诊断，边跑边把过程事件交给调用方（前端用 SSE 呈现）。 */
export async function analyzeCase(
  parsed: ParsedCase,
  facts: Facts,
  onEvent: (event: AnalysisEvent) => void,
  signal?: AbortSignal,
): Promise<{ result: AgentDiagnosis; rawText: string; thinking: string; sessionId: string; model: { provider: string; modelId: string } }> {
  let agent: Agent;
  try {
    agent = await getAgent();
  } catch (error) {
    throw new AnalysisError("AGENT_INIT_FAILED", `无法初始化嵌入式 Agent：${(error as Error).message}`);
  }

  // 没有密钥就先说清楚，不建会话也不发起请求：空密钥会让 SDK 建出客户端，直到调用时才 401。
  if (!hasModelKey()) throw new AnalysisError("MODEL_NOT_CONFIGURED", missingKeyMessage());

  let session;
  onEvent({ type: "status", message: "正在创建会话…" });
  try {
    session = await agent.createSession({
      workspaceDir: parsed.dir,
      provider: modelProvider(),
      modelId: modelId(),
      baseUrl: effectiveBaseUrl(),
    });
  } catch (error) {
    throw new AnalysisError(
      "MODEL_NOT_CONFIGURED",
      `没有可用的模型配置：${(error as Error).message}。请在应用自己的数据根配置模型 API Key（见 app/README.md）。`,
    );
  }

  const prompt = buildPrompt(parsed, facts);
  const startedAt = Date.now();
  let text = "";
  let thinking = "";
  // 工具轨迹：部分消息只带 tool_call_id，名字在 start 事件里记下来，结束时才能对上号。
  const toolNames = new Map<string, string>();
  try {
    for await (const msg of session.run([userText(prompt)], {
      approve: approveReadOnly(parsed.dir),
      signal,
    })) {
      if (isModelMessage(msg)) {
        const payload = msg.payload;
        if (payload.type === "partial_text" && payload.event_type === "delta") {
          text += payload.text;
          onEvent({ type: "text", delta: payload.text });
        } else if (payload.type === "partial_thinking" && payload.event_type === "delta") {
          thinking += payload.thinking;
          onEvent({ type: "thinking", delta: payload.thinking });
        } else if (payload.type === "partial_tool_call" && payload.event_type === "start") {
          toolNames.set(payload.tool_call_id, payload.name);
          onEvent({ type: "tool", name: toolDisplayName(payload.name), state: "start" });
        } else if (payload.type === "tool_call_output") {
          const name = toolNames.get(payload.tool_call_id) ?? "tool";
          onEvent({ type: "tool", name: toolDisplayName(name), state: "done", detail: summarizeToolOutput(payload.output) });
        }
      } else if (isEventMessage(msg)) {
        const payload = msg.payload;
        if (payload.type === "request_end" && payload.status !== "completed") {
          // error_code=auth 表示密钥/凭据问题，其余（fatal / retryable / aborted）按请求失败处理。
          const auth = payload.error_code === "auth";
          throw new AnalysisError(
            auth ? "MODEL_AUTH_ERROR" : "MODEL_REQUEST_FAILED",
            `模型请求未完成（${payload.status}${payload.error_code ? ` / ${payload.error_code}` : ""}）${payload.error_message ? `：${payload.error_message}` : ""}`,
          );
        }
        if (payload.type === "approval_decision" && payload.decision !== "allow") {
          const name = toolNames.get(payload.tool_call_id) ?? "tool";
          onEvent({ type: "tool", name: toolDisplayName(name), state: "deny", detail: `决策 ${payload.decision}，未执行` });
        }
        if (payload.type === "mcp_connect_end") {
          // 工具服务没连上时模型会"以为没有工具"，这里如实报出来，不让它变成静默降级。
          for (const result of payload.results ?? []) {
            if (result.status === "completed") continue;
            const detail = [result.error_code, result.error_message].filter(Boolean).join(" ");
            onEvent({
              type: "status",
              message: `受控工具服务 ${result.server} 未连接（${result.status}${detail ? `：${detail}` : ""}）：本轮模型没有设备工具可用。`,
            });
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError("MODEL_REQUEST_FAILED", `分析过程失败：${(error as Error).message}`);
  } finally {
    session.dispose();
  }

  if (!text.trim()) throw new AnalysisError("EMPTY_OUTPUT", "模型没有返回内容");

  const parsedJson = extractJson(text);
  const result = normalizeDiagnosis(parsedJson);
  onEvent({ type: "status", message: `分析完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s` });
  return {
    result,
    rawText: text,
    thinking,
    sessionId: session.sessionId,
    model: { provider: session.provider, modelId: session.modelId },
  };
}

/**
 * 模型是否已配置：真实尝试按固定模型建会话，失败按未配置处理（不打印任何密钥内容）。
 * 是否真的能调用还要看密钥是否有效——密钥错误会在诊断时以 MODEL_AUTH_ERROR 如实返回。
 */
export async function probeModel(): Promise<{
  configured: boolean;
  error: string | null;
  provider: string | null;
  modelId: string | null;
  provider_env_key: string;
  base_url: string;
  api_key_present: boolean;
}> {
  const apiKeyPresent = hasModelKey();
  const base = {
    provider_env_key: modelKeyEnv(),
    base_url: effectiveBaseUrl(),
    api_key_present: apiKeyPresent,
  };
  // 密钥是空的就一定"未配置"：只建会话会成功，直到真正调用才 401，那不算已就绪。
  if (!apiKeyPresent) {
    return { configured: false, error: missingKeyMessage(), provider: null, modelId: null, ...base };
  }
  try {
    const agent = await getAgent();
    const session = await agent.createSession({
      provider: modelProvider(),
      modelId: modelId(),
      baseUrl: base.base_url,
    });
    const info = { provider: session.provider, modelId: session.modelId };
    session.dispose();
    return { configured: true, error: null, ...info, ...base };
  } catch (error) {
    return { configured: false, error: (error as Error).message, provider: null, modelId: null, ...base };
  }
}
