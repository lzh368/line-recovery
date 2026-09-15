/**
 * 受控恢复流程（后端执行，不由模型自报）。
 *
 * 顺序固定：查询最新可信状态 → 执行点前重新核对前置条件 → 带 expected_revision / request_id
 * 请求动作 → **限时状态读回** → 按阶段判定。任何一步未知、过期、未获许可或失败都保留原状并说明，
 * 绝不跳到"恢复成功"。
 *
 * 同一 (案例, 动作) 只发一个请求号（见 decisions.ts）：重试复用原请求号，接口侧幂等，不会重复执行。
 *
 * 两个入口共用这里：
 * - 页面按钮 / HTTP → `runRecovery(..., { actor: "backend" })`；
 * - Agent 的受控工具（src/tools/agent-tools.ts）→ 同一 `runRecovery`，actor 为 "agent"。
 * 只读查询走 `queryStatus`，它只查询、只写一条 query 审计，没有任何隐式写操作。
 */
import crypto from "node:crypto";
import { appendAudit, type AuditActor, type AuditRecord, type ReadbackRecord } from "../audit.ts";
import { validate } from "../case/contracts.ts";
import { previousDecision, writeDecision } from "./decisions.ts";
import { executionMode, INTERFACES, callTool, ensureConnected, type InterfaceId } from "./registry.ts";

export type RecoveryAction = "resume_conveyor" | "start_cooling";

export interface DeviceStateLike {
  schema_version?: string;
  device_id?: string;
  source?: string;
  captured_at?: string;
  expires_at?: string;
  revision?: number;
  controller_online?: boolean | null;
  upstream_power_available?: boolean | null;
  drive_power_enabled?: boolean | null;
  drive_ready?: boolean | null;
  run_command?: boolean | null;
  operating_mode?: string;
  production_requested?: boolean | null;
  belt_speed_m_s?: number | null;
  infeed_count_total?: number | null;
  outfeed_count_total?: number | null;
  manual_removed_count_total?: number | null;
  cabinet_temperature_c?: number | null;
  emergency_stop_active?: boolean | null;
  maintenance_lockout?: boolean | null;
  guard_closed?: boolean | null;
  zone_clear?: boolean | null;
  downstream_ready?: boolean | null;
  unresolved_accumulation?: boolean | null;
  run_resume_permitted?: boolean | null;
  cooling_enabled?: boolean | null;
  cooling_fan_running?: boolean | null;
  cooling_fan_fault?: boolean | null;
  cooling_control_permitted?: boolean | null;
  thermal_pause_active?: boolean | null;
  temperature_recovery_ready?: boolean | null;
  [key: string]: unknown;
}

export interface PreconditionCheck {
  field: string;
  label: string;
  required: string;
  actual: unknown;
  ok: boolean;
}

export interface RecoveryOutcome {
  attempted: boolean;
  decision: "no_action" | "request_recovery" | "human_required" | "insufficient_evidence";
  status:
    | "not_attempted"
    | "requested"
    | "cooling_started"
    | "temperature_ready"
    | "running_confirmed"
    | "production_confirmed"
    | "rejected"
    | "failed"
    | "unknown";
  reason_code: string;
  summary: string;
  operations: Record<string, unknown>[];
  latest_state: DeviceStateLike | null;
  preconditions: PreconditionCheck[];
  audits: AuditRecord[];
  /**
   * 状态读回的显式预算与实际用掉的轮询次数。读回是用真实时间等的，
   * 不是靠多查几次跳过时间条件；超时也照实记录。
   */
  readback: ReadbackRecord | null;
  /** 同一请求号的重试：接口侧按 request_id 幂等，动作没有被第二次执行。 */
  replayed: boolean;
}

/**
 * 读回预算（真实时间）。查询次数上限与总时长一起限制：到点就停，不靠加查询次数跨过时间条件。
 * resume 的反馈在演示后端是几秒内出现；散热按后端"温度连续达标"判定，需要十几秒。
 */
export interface ReadbackPolicy {
  budgetMs: number;
  intervalMs: number;
  maxPolls: number;
}

export const READBACK_POLICY: Record<RecoveryAction, ReadbackPolicy> = {
  resume_conveyor: { budgetMs: 8_000, intervalMs: 1_000, maxPolls: 8 },
  start_cooling: { budgetMs: 30_000, intervalMs: 2_000, maxPolls: 15 },
};

/** 状态新鲜度：后端时钟与 captured_at 比较，最长 30 s，且不得晚于 expires_at。 */
export function freshnessOf(state: DeviceStateLike, now = new Date()): { fresh: boolean; detail: string } {
  if (state.source === "uploaded_snapshot") {
    return { fresh: false, detail: "source=uploaded_snapshot：上传快照只是历史资料，不作为执行依据" };
  }
  if (state.source !== "demo_backend" && state.source !== "live_backend") {
    return { fresh: false, detail: `source=${String(state.source)}：不是可信后端状态` };
  }
  const captured = Date.parse(String(state.captured_at ?? ""));
  const expires = Date.parse(String(state.expires_at ?? ""));
  if (!Number.isFinite(captured) || !Number.isFinite(expires)) {
    return { fresh: false, detail: "缺少可解析的 captured_at / expires_at" };
  }
  const ageS = (now.getTime() - captured) / 1000;
  if (ageS > 30) return { fresh: false, detail: `状态已过期：采集于 ${ageS.toFixed(1)} s 前（上限 30 s）` };
  if (now.getTime() > expires) return { fresh: false, detail: "状态已超过 expires_at 新鲜度上限" };
  return { fresh: true, detail: `状态新鲜：采集于 ${ageS.toFixed(1)} s 前，版本 ${String(state.revision)}` };
}

function check(field: string, label: string, required: string, actual: unknown, ok: boolean): PreconditionCheck {
  return { field, label, required, actual, ok };
}

/** 恢复输送的执行点前核对（服务端还会再核对一次）。 */
export function resumePreconditions(state: DeviceStateLike, hasThermalContext: boolean): PreconditionCheck[] {
  const checks: PreconditionCheck[] = [
    check("controller_online", "控制器在线", "true", state.controller_online, state.controller_online === true),
    check("upstream_power_available", "上游电源可用", "true", state.upstream_power_available, state.upstream_power_available === true),
    check("drive_power_enabled", "驱动支路供电使能", "true", state.drive_power_enabled, state.drive_power_enabled === true),
    check("drive_ready", "驱动就绪", "true", state.drive_ready, state.drive_ready === true),
    check("operating_mode", "运行模式为 AUTO", "AUTO", state.operating_mode, state.operating_mode === "AUTO"),
    check("production_requested", "生产任务有效", "true", state.production_requested, state.production_requested === true),
    check("run_resume_permitted", "后端运行许可有效", "true", state.run_resume_permitted, state.run_resume_permitted === true),
    check("emergency_stop_active", "急停未生效", "false", state.emergency_stop_active, state.emergency_stop_active === false),
    check("maintenance_lockout", "维护锁定未生效", "false", state.maintenance_lockout, state.maintenance_lockout === false),
    check("guard_closed", "防护回路闭合", "true", state.guard_closed, state.guard_closed === true),
    check("zone_clear", "区域条件合格", "true", state.zone_clear, state.zone_clear === true),
    check("downstream_ready", "下游可接收", "true", state.downstream_ready, state.downstream_ready === true),
    check("unresolved_accumulation", "无未解决积聚", "false", state.unresolved_accumulation, state.unresolved_accumulation === false),
  ];
  if (hasThermalContext) {
    checks.push(
      check("thermal_pause_active", "无温控暂停", "false", state.thermal_pause_active, state.thermal_pause_active === false),
      check(
        "temperature_recovery_ready",
        "温度恢复条件合格",
        "true",
        state.temperature_recovery_ready,
        state.temperature_recovery_ready === true,
      ),
    );
  }
  return checks;
}

/** 散热前核对。 */
export function coolingPreconditions(state: DeviceStateLike): PreconditionCheck[] {
  return [
    check("controller_online", "控制器在线", "true", state.controller_online, state.controller_online === true),
    check(
      "cooling_control_permitted",
      "后端散热控制许可有效",
      "true",
      state.cooling_control_permitted,
      state.cooling_control_permitted === true,
    ),
    check("cooling_fan_fault", "风机无故障", "false", state.cooling_fan_fault, state.cooling_fan_fault === false),
    check("emergency_stop_active", "急停未生效", "false", state.emergency_stop_active, state.emergency_stop_active === false),
    check("maintenance_lockout", "维护锁定未生效", "false", state.maintenance_lockout, state.maintenance_lockout === false),
    check("guard_closed", "防护回路闭合", "true", state.guard_closed, state.guard_closed === true),
    check("zone_clear", "区域条件合格", "true", state.zone_clear, state.zone_clear === true),
  ];
}

function interfaceOf(action: RecoveryAction): InterfaceId {
  return action === "resume_conveyor" ? "power-control" : "cooling-control";
}

function newRequestId(caseId: string, action: RecoveryAction): string {
  return `req_${caseId.replace(/[^A-Za-z0-9_]/g, "")}_${action}_${crypto.randomBytes(4).toString("hex")}`.slice(0, 80);
}

function audit(args: {
  caseId: string;
  actor: AuditActor;
  phase: "query" | "precheck" | "request" | "feedback" | "blocked";
  interfaceId: InterfaceId | null;
  tool: string | null;
  action: RecoveryAction | null;
  outcome: string;
  reasonCode: string;
  message: string;
  requestId?: string | null;
  expectedRevision?: number | null;
  postState?: unknown;
  readback?: ReadbackRecord | null;
}): AuditRecord {
  return appendAudit({
    case_id: args.caseId,
    phase: args.phase,
    actor: args.actor,
    interface_id: args.interfaceId,
    tool: args.tool,
    action: args.action,
    execution_mode: executionMode(),
    outcome: args.outcome,
    reason_code: args.reasonCode,
    message: args.message,
    request_id: args.requestId ?? null,
    expected_revision: args.expectedRevision ?? null,
    post_state: args.postState ?? null,
    readback: args.readback ?? null,
  });
}

function blockedOutcome(caseId: string, action: RecoveryAction, actor: AuditActor, message: string, reasonCode: string): RecoveryOutcome {
  const interfaceId = interfaceOf(action);
  const record = audit({
    caseId,
    actor,
    phase: "blocked",
    interfaceId,
    tool: INTERFACES[interfaceId].writeTool,
    action,
    outcome: "TOOLS_UNAVAILABLE",
    reasonCode,
    message,
  });
  return {
    attempted: false,
    decision: "human_required",
    status: "not_attempted",
    reason_code: reasonCode,
    summary: message,
    operations: [],
    latest_state: null,
    preconditions: [],
    audits: [record],
    readback: null,
    replayed: false,
  };
}

export interface RecoveryOptions {
  hasThermalContext?: boolean;
  /** 谁触发的这次恢复：Agent 的受控工具 → "agent"；页面按钮 / HTTP → "backend"。 */
  actor?: AuditActor;
}

/**
 * 执行一次恢复请求。`baseline` 是动作前新查询到的状态（用于产出对照），调用方负责传入。
 */
export async function runRecovery(caseId: string, action: RecoveryAction, options?: RecoveryOptions): Promise<RecoveryOutcome> {
  const actor: AuditActor = options?.actor ?? "backend";
  const interfaceId = interfaceOf(action);
  const def = INTERFACES[interfaceId];
  // 需要用工具时才连接（Agent 的受控工具服务是独立进程，必须自己连设备接口）；
  // 没配置服务或连不上，都如实按"工具未连接"处理。
  if (!(await ensureConnected(interfaceId))) {
    return blockedOutcome(
      caseId,
      action,
      actor,
      `工具未连接：${def.title} 当前没有可运行的服务进程，未查询也未执行任何动作；上传资料中的许可不授予执行权限。`,
      "TOOLS_UNAVAILABLE",
    );
  }

  const audits: AuditRecord[] = [];
  const deviceId = (await resolveDeviceId(caseId)) ?? "";

  // 1) 先查询当前可信状态（不使用上传快照）
  let state: DeviceStateLike;
  try {
    const raw = (await callTool(interfaceId, def.statusTool, { device_id: deviceId })) as DeviceStateLike;
    const validation = validate("device-state.schema.json", raw);
    if (!validation.valid) {
      audits.push(
        audit({
          caseId,
          actor,
          phase: "precheck",
          interfaceId,
          tool: def.statusTool,
          action,
          outcome: "STATUS_INVALID",
          reasonCode: "STATUS_SCHEMA_INVALID",
          message: `工具返回的状态不符合 device-state 契约：${validation.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
        }),
      );
      return {
        attempted: false,
        decision: "human_required",
        status: "unknown",
        reason_code: "STATUS_SCHEMA_INVALID",
        summary: "工具返回的状态无法通过契约校验，未执行动作。",
        operations: [],
        latest_state: null,
        preconditions: [],
        audits,
        readback: null,
        replayed: false,
      };
    }
    state = raw;
  } catch (error) {
    audits.push(
      audit({
        caseId,
        actor,
        phase: "precheck",
        interfaceId,
        tool: def.statusTool,
        action,
        outcome: "QUERY_FAILED",
        reasonCode: "STATUS_QUERY_FAILED",
        message: `查询最新状态失败：${(error as Error).message}`,
      }),
    );
    return {
      attempted: false,
      decision: "human_required",
      status: "unknown",
      reason_code: "STATUS_QUERY_FAILED",
      summary: "查询最新状态失败，未执行动作，也未沿用上传快照的结论。",
      operations: [],
      latest_state: null,
      preconditions: [],
      audits,
      readback: null,
      replayed: false,
    };
  }

  const freshness = freshnessOf(state);
  if (!freshness.fresh) {
    audits.push(
      audit({
        caseId,
        actor,
        phase: "precheck",
        interfaceId,
        tool: def.statusTool,
        action,
        outcome: "STATUS_STALE",
        reasonCode: "STATUS_NOT_FRESH",
        message: freshness.detail,
        postState: state,
      }),
    );
    return {
      attempted: false,
      decision: "human_required",
      status: "unknown",
      reason_code: "STATUS_NOT_FRESH",
      summary: `最新状态不可用于执行：${freshness.detail}`,
      operations: [],
      latest_state: state,
      preconditions: [],
      audits,
      readback: null,
      replayed: false,
    };
  }

  const preconditions =
    action === "resume_conveyor" ? resumePreconditions(state, options?.hasThermalContext === true) : coolingPreconditions(state);
  const failed = preconditions.filter((c) => !c.ok);
  audits.push(
    audit({
      caseId,
      actor,
      phase: "precheck",
      interfaceId,
      tool: def.statusTool,
      action,
      outcome: failed.length ? "PRECONDITION_FAILED" : "PRECONDITIONS_OK",
      reasonCode: failed.length ? "PRECONDITION_FAILED" : "PRECONDITIONS_OK",
      message: failed.length
        ? `前置条件不满足，未请求动作：${failed.map((c) => `${c.label}=${String(c.actual)}（要求 ${c.required}）`).join("；")}`
        : `前置条件全部满足（版本 ${String(state.revision)}），可以请求动作。`,
      expectedRevision: typeof state.revision === "number" ? state.revision : null,
      postState: state,
    }),
  );
  if (failed.length) {
    return {
      attempted: false,
      decision: "human_required",
      status: "rejected",
      reason_code: "PRECONDITION_FAILED",
      summary: `未请求动作：${failed.map((c) => c.label).join("、")} 不满足当前要求。`,
      operations: [],
      latest_state: state,
      preconditions,
      audits,
      readback: null,
      replayed: false,
    };
  }

  // 2) 请求动作：expected_revision 防陈旧写入，request_id 防重复执行。
  //    只有"同一个请求"才复用请求号：接口按 (request_id + 参数指纹) 幂等，指纹里含 expected_revision，
  //    所以版本一致时复用 = 真正的重试（接口返回原结果，不重复执行）；版本已变则说明这是新的一次
  //    动作请求，必须换号 —— 否则接口会按"同号不同参数"判成冲突，把这次请求整条丢掉。
  const expectedRevision = typeof state.revision === "number" ? state.revision : 0;
  const previous = previousDecision(caseId, action);
  const replaying = Boolean(previous && previous.expected_revision === expectedRevision);
  const requestId = replaying ? previous!.request_id : newRequestId(caseId, action);
  let actionResult: Record<string, any>;
  try {
    const raw = (await callTool(interfaceId, def.writeTool, {
      device_id: deviceId,
      expected_revision: expectedRevision,
      request_id: requestId,
    })) as Record<string, any>;
    const validation = validate("action-result.schema.json", raw);
    if (!validation.valid) {
      audits.push(
        audit({
          caseId,
          actor,
          phase: "request",
          interfaceId,
          tool: def.writeTool,
          action,
          outcome: "RESULT_INVALID",
          reasonCode: "ACTION_RESULT_SCHEMA_INVALID",
          message: `动作返回不符合 action-result 契约：${validation.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
          requestId,
          expectedRevision,
        }),
      );
      return {
        attempted: true,
        decision: "request_recovery",
        status: "unknown",
        reason_code: "ACTION_RESULT_SCHEMA_INVALID",
        summary: "动作返回无法通过契约校验，按未确认处理。",
        operations: [],
        latest_state: state,
        preconditions,
        audits,
        readback: null,
        replayed: replaying,
      };
    }
    actionResult = raw;
  } catch (error) {
    audits.push(
      audit({
        caseId,
        actor,
        phase: "request",
        interfaceId,
        tool: def.writeTool,
        action,
        outcome: "REQUEST_FAILED",
        reasonCode: "ACTION_REQUEST_FAILED",
        message: `请求动作失败：${(error as Error).message}`,
        requestId,
        expectedRevision,
      }),
    );
    return {
      attempted: true,
      decision: "request_recovery",
      status: "failed",
      reason_code: "ACTION_REQUEST_FAILED",
      summary: "动作请求失败，未确认任何状态变化。",
      operations: [],
      latest_state: state,
      preconditions,
      audits,
      readback: null,
      replayed: replaying,
    };
  }

  // 接口侧按 (request_id + 参数指纹) 幂等：返回的 operation_id 与上次相同 = 这次没有重新执行。
  const replayed = Boolean(previous?.operation_id && actionResult.operation_id === previous.operation_id);
  audits.push(
    audit({
      caseId,
      actor,
      phase: "request",
      interfaceId,
      tool: def.writeTool,
      action,
      outcome: replayed ? "IDEMPOTENT_REPLAY" : String(actionResult.status ?? "unknown").toUpperCase(),
      reasonCode: replayed ? "IDEMPOTENT_REPLAY" : String(actionResult.reason_code ?? "UNKNOWN"),
      message: replayed
        ? `同一请求号的重试：接口侧按 ${requestId} 幂等返回原结果，动作没有被第二次执行。${String(actionResult.message ?? "")}`
        : String(actionResult.message ?? ""),
      requestId,
      expectedRevision,
      postState: actionResult.post_state ?? null,
    }),
  );
  writeDecision({
    case_id: caseId,
    action,
    actor,
    at: new Date().toISOString(),
    device_id: deviceId,
    request_id: requestId,
    expected_revision: expectedRevision,
    response: actionResult as Record<string, unknown>,
    operation_id: typeof actionResult.operation_id === "string" ? actionResult.operation_id : null,
    outcome: null,
  });

  const finish = (outcome: RecoveryOutcome): RecoveryOutcome => {
    if (actor === "agent") recordAgentOutcome(caseId, action, actor, deviceId, requestId, expectedRevision, actionResult, outcome);
    return outcome;
  };

  const declaredStatus = String(actionResult.status ?? "unknown");
  if (declaredStatus === "rejected" || declaredStatus === "failed") {
    return finish({
      attempted: true,
      decision: "request_recovery",
      status: declaredStatus === "rejected" ? "rejected" : "failed",
      reason_code: String(actionResult.reason_code ?? "UNKNOWN"),
      summary: `后端未接受动作：${String(actionResult.message ?? "无附加说明")}`,
      operations: [actionResult],
      latest_state: (actionResult.post_state as DeviceStateLike) ?? state,
      preconditions,
      audits,
      readback: null,
      replayed,
    });
  }

  // 3) 限时状态读回：受理 ≠ 完成。到预算就停，如实保留当时的阶段。
  const policy = READBACK_POLICY[action];
  const readbackStarted = Date.now();
  let polls = 0;
  let feedback: DeviceStateLike =
    (actionResult.post_state as DeviceStateLike) ?? state;
  let stage = evaluateStage(action, state, feedback, declaredStatus);
  let readbackError: string | null = null;
  while (!isFinalStage(stage.status) && polls < policy.maxPolls && Date.now() - readbackStarted < policy.budgetMs) {
    await sleep(policy.intervalMs);
    polls += 1;
    try {
      feedback = (await callTool(interfaceId, def.statusTool, { device_id: deviceId })) as DeviceStateLike;
    } catch (error) {
      readbackError = (error as Error).message;
      break;
    }
    stage = evaluateStage(action, state, feedback, declaredStatus);
  }
  const readback: ReadbackRecord = {
    budget_ms: policy.budgetMs,
    interval_ms: policy.intervalMs,
    polls,
    polls_limit: policy.maxPolls,
    duration_ms: Date.now() - readbackStarted,
    timed_out: !isFinalStage(stage.status),
  };

  if (readbackError) {
    audits.push(
      audit({
        caseId,
        actor,
        phase: "feedback",
        interfaceId,
        tool: def.statusTool,
        action,
        outcome: "FEEDBACK_UNKNOWN",
        reasonCode: "FEEDBACK_QUERY_FAILED",
        message: `读回期间查询失败：${readbackError}（已查询 ${polls} 次，预算 ${policy.budgetMs} ms）`,
        requestId,
        expectedRevision,
        postState: feedback,
        readback,
      }),
    );
    return finish({
      attempted: true,
      decision: "request_recovery",
      status: "requested",
      reason_code: "FEEDBACK_QUERY_FAILED",
      summary: "动作已受理，但后续反馈未知，按未确认处理。",
      operations: [actionResult],
      latest_state: feedback,
      preconditions,
      audits,
      readback,
      replayed,
    });
  }

  audits.push(
    audit({
      caseId,
      actor,
      phase: "feedback",
      interfaceId,
      tool: def.statusTool,
      action,
      outcome: stage.reasonCode,
      reasonCode: stage.reasonCode,
      message: `${stage.message}（读回：${polls} 次查询 / 预算 ${policy.budgetMs} ms / 实际 ${readback.duration_ms} ms${readback.timed_out ? "，预算内未达最终阶段" : ""}）`,
      requestId,
      expectedRevision,
      postState: feedback,
      readback,
    }),
  );

  return finish({
    attempted: true,
    decision: "request_recovery",
    status: stage.status,
    reason_code: stage.reasonCode,
    summary: stage.message,
    operations: [actionResult],
    latest_state: feedback,
    preconditions,
    audits,
    readback,
    replayed,
  });
}

/** 最终阶段：到了就没必要继续查询；没到就是预算内的"尚未确认"。 */
function isFinalStage(status: RecoveryOutcome["status"]): boolean {
  return status === "production_confirmed" || status === "temperature_ready";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Agent 触发的恢复：把结果连同决策一起留存，供诊断报告与前端读取。 */
function recordAgentOutcome(
  caseId: string,
  action: RecoveryAction,
  actor: AuditActor,
  deviceId: string,
  requestId: string,
  expectedRevision: number,
  response: Record<string, unknown>,
  outcome: RecoveryOutcome,
): void {
  writeDecision({
    case_id: caseId,
    action,
    actor,
    at: new Date().toISOString(),
    device_id: deviceId,
    request_id: requestId,
    expected_revision: expectedRevision,
    response,
    operation_id: typeof response.operation_id === "string" ? response.operation_id : null,
    outcome,
  });
}

/**
 * 阶段判定：
 * - resume_conveyor：受理→requested；带速恢复→running_confirmed；出口计数超过动作前基准→production_confirmed
 * - start_cooling：受理→requested；风机有运行反馈→cooling_started；后端判定温度恢复就绪→temperature_ready
 */
function evaluateStage(
  action: RecoveryAction,
  before: DeviceStateLike,
  after: DeviceStateLike,
  declaredStatus: string,
): { status: RecoveryOutcome["status"]; reasonCode: string; message: string } {
  if (action === "start_cooling") {
    // 温度合格 ≠ 可以恢复输送：后端运行许可（run_resume_permitted）由后端自己恢复，
    // 这里只如实报告它到了哪一步，绝不替后端宣告"可以恢复生产了"。
    if (after.temperature_recovery_ready === true && after.run_resume_permitted === true) {
      return {
        status: "temperature_ready",
        reasonCode: "TEMPERATURE_READY",
        message: "后端判定温度恢复条件合格，且运行许可已恢复。",
      };
    }
    if (after.temperature_recovery_ready === true) {
      return {
        status: "cooling_started",
        reasonCode: "RUN_PERMIT_PENDING",
        message: "温度已达恢复条件，但后端运行许可尚未恢复；恢复输送需要另行判断。",
      };
    }
    if (after.cooling_fan_running === true) {
      return {
        status: "cooling_started",
        reasonCode: "COOLING_FAN_RUNNING",
        message: "风机已有运行反馈；温度是否达标仍需后端按连续时间判定。",
      };
    }
    return {
      status: declaredStatus === "confirmed" ? "cooling_started" : "requested",
      reasonCode: "COOLING_FEEDBACK_PENDING",
      message: "命令已受理，但尚未取得风机运行反馈；不代表温度已经下降。",
    };
  }

  const outfeedBefore = typeof before.outfeed_count_total === "number" ? before.outfeed_count_total : null;
  const outfeedAfter = typeof after.outfeed_count_total === "number" ? after.outfeed_count_total : null;
  if (outfeedBefore !== null && outfeedAfter !== null && outfeedAfter > outfeedBefore && (after.belt_speed_m_s ?? 0) > 0.02) {
    return {
      status: "production_confirmed",
      reasonCode: "OUTFEED_INCREASED",
      message: `输送已运行（带速 ${after.belt_speed_m_s} m/s），出口累计由 ${outfeedBefore} 增至 ${outfeedAfter}，产出恢复有新的证据。`,
    };
  }
  if ((after.belt_speed_m_s ?? 0) > 0.02) {
    return {
      status: "running_confirmed",
      reasonCode: "BELT_SPEED_RECOVERED",
      message: `带速已恢复（${after.belt_speed_m_s} m/s）；出口产出是否恢复还需对照动作前基准的后续计数。`,
    };
  }
  return {
    status: "requested",
    reasonCode: "RUN_FEEDBACK_PENDING",
    message: "命令已受理，尚未观察到带速恢复；受理不等于执行完成。",
  };
}

async function resolveDeviceId(caseId: string): Promise<string | null> {
  const { getCase } = await import("../case/store.ts");
  try {
    return getCase(caseId).parsed.deviceId;
  } catch {
    return null;
  }
}

export interface QueryResult {
  ok: boolean;
  interface_id: InterfaceId;
  tool: string;
  /** 工具返回并已通过 device-state 契约校验的状态；不可信时为 null。 */
  state: DeviceStateLike | null;
  freshness: { fresh: boolean; detail: string } | null;
  schema_valid: boolean;
  reason_code: string;
  message: string;
  audit: AuditRecord | null;
}

/**
 * 只读查询：查一次最新可信状态，写一条 `query` 审计，**不做任何隐式写操作**。
 *
 * Agent 的只读工具（get_device_status / get_cooling_status）走这里；页面按钮不经过它。
 * 未连接、查询失败、契约不符都如实返回失败原因，绝不返回编造的字段。
 */
export async function queryStatus(caseId: string, interfaceId: InterfaceId, actor: AuditActor): Promise<QueryResult> {
  const def = INTERFACES[interfaceId];
  const base = { interface_id: interfaceId, tool: def.statusTool, state: null, freshness: null, schema_valid: false };
  const log = (outcome: string, reasonCode: string, message: string, postState?: unknown): AuditRecord =>
    audit({
      caseId,
      actor,
      phase: "query",
      interfaceId,
      tool: def.statusTool,
      action: null,
      outcome,
      reasonCode,
      message,
      postState,
    });

  if (!(await ensureConnected(interfaceId))) {
    const message = `工具未连接：${def.title} 当前没有可运行的服务进程，没有查询到任何状态。`;
    return { ...base, ok: false, reason_code: "TOOLS_UNAVAILABLE", message, audit: log("TOOLS_UNAVAILABLE", "TOOLS_UNAVAILABLE", message) };
  }

  const deviceId = (await resolveDeviceId(caseId)) ?? "";
  let raw: DeviceStateLike;
  try {
    raw = (await callTool(interfaceId, def.statusTool, { device_id: deviceId })) as DeviceStateLike;
  } catch (error) {
    const message = `查询最新状态失败：${(error as Error).message}`;
    return { ...base, ok: false, reason_code: "STATUS_QUERY_FAILED", message, audit: log("QUERY_FAILED", "STATUS_QUERY_FAILED", message) };
  }

  const validation = validate("device-state.schema.json", raw);
  if (!validation.valid) {
    const message = `工具返回的状态不符合 device-state 契约：${validation.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`;
    return { ...base, ok: false, reason_code: "STATUS_SCHEMA_INVALID", message, audit: log("STATUS_INVALID", "STATUS_SCHEMA_INVALID", message) };
  }

  const freshness = freshnessOf(raw);
  const message = freshness.fresh
    ? `已查询到最新状态：${freshness.detail}。`
    : `已查询到状态但不可用作执行依据：${freshness.detail}`;
  return {
    ...base,
    ok: freshness.fresh,
    state: raw,
    freshness,
    schema_valid: true,
    reason_code: freshness.fresh ? "STATUS_OK" : "STATUS_NOT_FRESH",
    message,
    audit: log(freshness.fresh ? "STATUS_OK" : "STATUS_STALE", freshness.fresh ? "STATUS_OK" : "STATUS_NOT_FRESH", message, raw),
  };
}
