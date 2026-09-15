/**
 * 恢复决策记录：一个 (案例, 动作) 只发一个 request_id。
 *
 * 目的（interfaces/README.md）：Agent 决定动作后，由后端附加最新 `expected_revision` 和唯一
 * `request_id`。模型因为输出格式重来一次、或诊断重跑时再调一次工具，都复用同一个请求号 ——
 * 接口侧按请求号幂等，因此不会第二次执行动作。
 *
 * 记录与审计同生命周期：审计被清掉（载入 example / 删除案例 / 重置演示后端）时一并清掉，
 * 之后重新决策会得到新的请求号。这里只存"发起过什么请求、返回了什么"，不含任何模型输出。
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIT_DIR, ensureDir } from "../paths.ts";
import type { AuditActor } from "../audit.ts";
import type { RecoveryAction, RecoveryOutcome } from "./recovery.ts";

export interface RecoveryDecision {
  case_id: string;
  action: RecoveryAction;
  /** 谁发起的这次决策：agent（受控工具）或 backend（页面按钮）。 */
  actor: AuditActor;
  at: string;
  device_id: string;
  request_id: string;
  expected_revision: number;
  /** 写工具返回的原始结果；同一请求号的重试会原样取回它（接口侧幂等），不再执行。 */
  response: Record<string, unknown>;
  operation_id: string | null;
  /** Agent 决策连同完整结果一起留存，供报告与前端使用（后端按钮路径为 null）。 */
  outcome: RecoveryOutcome | null;
}

type DecisionFile = Partial<Record<RecoveryAction, RecoveryDecision>>;

function decisionsPath(caseId: string): string {
  return path.join(AUDIT_DIR, `${caseId}.recovery.json`);
}

export function readDecisions(caseId: string): DecisionFile {
  const file = decisionsPath(caseId);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DecisionFile;
  } catch {
    return {};
  }
}

/** 已就某个动作发过请求的话，返回那次决策（调用方据此复用请求号）。 */
export function previousDecision(caseId: string, action: RecoveryAction): RecoveryDecision | null {
  return readDecisions(caseId)[action] ?? null;
}

export function writeDecision(decision: RecoveryDecision): RecoveryDecision {
  ensureDir(AUDIT_DIR);
  const all = readDecisions(decision.case_id);
  all[decision.action] = decision;
  fs.writeFileSync(decisionsPath(decision.case_id), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  return decision;
}

export function clearDecisions(caseId: string): void {
  fs.rmSync(decisionsPath(caseId), { force: true });
}

/**
 * 本次诊断期间由 Agent 触发的最近一次恢复结果（`since` 之前的不算，避免把上一轮的结果
 * 写进这一轮的报告）。没有 Agent 工具轨迹时返回 null —— 报告里就不会出现凭空的 operations。
 */
export function latestAgentOutcome(caseId: string, since: string): { action: RecoveryAction; at: string; outcome: RecoveryOutcome } | null {
  const all = readDecisions(caseId);
  const candidates = Object.values(all)
    .filter((d): d is RecoveryDecision => Boolean(d && d.actor === "agent" && d.outcome && d.at >= since))
    .sort((a, b) => a.at.localeCompare(b.at));
  const last = candidates[candidates.length - 1];
  return last ? { action: last.action, at: last.at, outcome: last.outcome as RecoveryOutcome } : null;
}
