/**
 * 后端审计记录：唯一"执行过什么"的事实来源。
 *
 * 前端的"动作与反馈"只读取这里的内容；模型写出的计划不会被当作已执行的动作
 * （contracts/README.md：禁止把报告里手写的 operations 当作已经执行的动作）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_DIR, CASES_DIR, ensureDir } from "./paths.ts";
import { clearDecisions } from "./tools/decisions.ts";

export type AuditPhase = "query" | "precheck" | "request" | "feedback" | "blocked";

/** 谁触发了这次工具调用：被测 Agent、应用后端（页面按钮），还是人工直接调用接口。 */
export type AuditActor = "agent" | "backend" | "operator";

export interface AuditRecord {
  audit_id: string;
  case_id: string;
  at: string;
  phase: AuditPhase;
  actor: AuditActor;
  interface_id: string | null;
  tool: string | null;
  action: string | null;
  execution_mode: "dry_run" | "live";
  outcome: string;
  reason_code: string;
  message: string;
  request_id?: string | null;
  expected_revision?: number | null;
  post_state?: unknown;
  /** 状态读回的显式预算与实际用掉的轮询次数（只在 feedback 阶段出现）。 */
  readback?: ReadbackRecord | null;
}

export interface ReadbackRecord {
  budget_ms: number;
  interval_ms: number;
  polls: number;
  polls_limit: number;
  duration_ms: number;
  timed_out: boolean;
}

function auditFile(caseId: string): string {
  return path.join(AUDIT_DIR, `${caseId}.jsonl`);
}

export function appendAudit(record: Omit<AuditRecord, "audit_id" | "at"> & { at?: string }): AuditRecord {
  ensureDir(AUDIT_DIR);
  const full: AuditRecord = {
    audit_id: `op_${crypto.randomBytes(6).toString("hex")}`,
    at: record.at ?? new Date().toISOString(),
    ...record,
  } as AuditRecord;
  fs.appendFileSync(auditFile(record.case_id), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

export function readAudit(caseId: string): AuditRecord[] {
  const file = auditFile(caseId);
  if (!fs.existsSync(file)) return [];
  const out: AuditRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      /* 忽略损坏行，审计文件不因一行损坏而不可读 */
    }
  }
  return out;
}

export function clearAudit(caseId: string): void {
  fs.rmSync(auditFile(caseId), { force: true });
  fs.rmSync(path.join(CASES_DIR, `${caseId}.audit.jsonl`), { force: true });
  // 决策记录与审计同生命周期：清掉审计就没有"已经执行过"这回事，请求号也一并作废。
  clearDecisions(caseId);
}
