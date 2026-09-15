/**
 * 报告装配与持久化。
 *
 * 分层（interfaces/README.md）：
 * - diagnosis 来自 Agent，只描述上传时间窗；
 * - recovery 的 operations 与 latest_state 只能来自后端审计绑定的真实工具轨迹，
 *   模型写出的计划不会被写进报告当作已执行的动作。
 */
import fs from "node:fs";
import path from "node:path";
import { REPORTS_DIR, ensureDir } from "../paths.ts";
import { validate, type ValidationIssue } from "../case/contracts.ts";
import type { CaseView } from "../case/store.ts";
import type { AgentDiagnosis } from "./agent.ts";
import type { RecoveryOutcome } from "../tools/recovery.ts";

export interface StoredReport {
  case_id: string;
  created_at: string;
  updated_at: string;
  report: Record<string, unknown>;
  valid: boolean;
  issues: ValidationIssue[];
  model: { provider: string; modelId: string } | null;
  session_id: string | null;
  recovery_plan: AgentDiagnosis["recovery_plan"] | null;
  raw_model_output: string | null;
  /** 计划里提出但尚未执行的动作，单独记录，避免与已执行动作混淆。 */
  pending_plan: { preferred_action: string | null; reason: string } | null;
  recovery_outcome: RecoveryOutcome | null;
}

function reportPath(caseId: string): string {
  return path.join(REPORTS_DIR, `${caseId}.json`);
}

export function saveReport(report: StoredReport): StoredReport {
  ensureDir(REPORTS_DIR);
  fs.writeFileSync(reportPath(report.case_id), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function readReport(caseId: string): StoredReport | null {
  const file = reportPath(caseId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredReport;
  } catch {
    return null;
  }
}

export function clearReport(caseId: string): void {
  fs.rmSync(reportPath(caseId), { force: true });
}

/** 报告里的 recovery 段：没有执行过就不写任何操作记录。 */
export function buildRecoverySection(
  plan: AgentDiagnosis["recovery_plan"] | null,
  outcome: RecoveryOutcome | null,
): Record<string, unknown> {
  if (!outcome) {
    const decision =
      plan?.decision === "no_action"
        ? "no_action"
        : plan?.decision === "human_required"
          ? "human_required"
          : plan?.decision === "request_recovery"
            ? "request_recovery"
            : "insufficient_evidence";
    const summary =
      decision === "request_recovery"
        ? `已判断需要恢复（计划动作：${plan?.preferred_action ?? "未指定"}），但本轮尚未执行任何工具动作。`
        : decision === "no_action"
          ? "上传时间窗内不需要进一步的控制动作。"
          : decision === "human_required"
            ? "需要由现场人员处理，未请求任何工具动作。"
            : "资料不足以决定动作，未请求任何工具动作。";
    return { decision, status: "not_attempted", summary, operations: [], latest_state: null };
  }
  return {
    decision: outcome.decision,
    status: outcome.status,
    summary: outcome.summary,
    operations: outcome.operations,
    latest_state: outcome.latest_state,
  };
}

export function assembleReport(args: {
  view: CaseView;
  diagnosis: AgentDiagnosis;
  outcome: RecoveryOutcome | null;
  model: { provider: string; modelId: string } | null;
  sessionId: string | null;
  rawText: string;
  createdAt?: string;
  updatedAt?: string;
}): StoredReport {
  const { view, diagnosis, outcome } = args;
  const limitations = [...diagnosis.limitations];
  if (!outcome) {
    limitations.push("本轮未调用任何设备工具：recovery.operations 为空，latest_state 为 null。");
  } else if (!outcome.attempted) {
    limitations.push(`未执行动作：${outcome.summary}`);
  }
  const report = {
    schema_version: "0.1",
    case_id: view.parsed.caseId,
    device_id: view.parsed.deviceId,
    diagnosis: diagnosis.diagnosis,
    recovery: buildRecoverySection(diagnosis.recovery_plan, outcome),
    limitations,
  };
  const validation = validate("report.schema.json", report);
  const now = new Date().toISOString();
  return {
    case_id: view.parsed.caseId,
    created_at: args.createdAt ?? now,
    updated_at: args.updatedAt ?? now,
    report,
    valid: validation.valid,
    issues: validation.issues,
    model: args.model,
    session_id: args.sessionId,
    recovery_plan: diagnosis.recovery_plan,
    raw_model_output: args.rawText,
    pending_plan:
      outcome === null && diagnosis.recovery_plan.decision === "request_recovery"
        ? {
            preferred_action: diagnosis.recovery_plan.preferred_action,
            reason: diagnosis.recovery_plan.reason,
          }
        : null,
    recovery_outcome: outcome,
  };
}
