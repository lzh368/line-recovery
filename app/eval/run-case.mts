/**
 * 评测入口（单例）：用**应用真实的链路**跑一个案例。
 *
 * 这一步刻意不重写任何判定逻辑：
 * - 案例装载用 src/case/store.ts 的 loadExample（= 页面上"载入 example"走的同一段代码）；
 * - 诊断用 src/diagnosis/agent.ts 的 analyzeCase（= /api/cases/:id/analyze 走的同一段代码），
 *   它带着 Agent State 里的受控工具 MCP 服务（mcp__recovery-control__*）；
 * - 报告用 src/diagnosis/report.ts 的 assembleReport + saveReport（= SSE 流结束时做的同一件事）。
 *
 * 因此在评测目录里留下的就是"实际应用跑一遍"的全部痕迹：
 * 案例副本、工具审计（runtime/audit/*.jsonl）、报告、会话 trace、模型原始输出。
 *
 * 用法（由 run-suite.mts 调用，也可手工调用）：
 *   npx tsx eval/run-case.mts --case lr_101 --input <案例输入目录> \
 *     --state <Agent State 版本快照目录> --run <本 run 目录> [--fixture <夹具>] [--profile <profile>]
 */
import fs from "node:fs";
import path from "node:path";
import {
  EvalError,
  findTraces,
  hashTree,
  initDatabase,
  layoutOf,
  parseArgs,
  required,
  stageState,
  writeJson,
  writeRunInterfacesConfig,
} from "./lib.mts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const caseId = required(args, "case");
  const inputDir = path.resolve(required(args, "input"));
  const stateSnapshot = path.resolve(required(args, "state"));
  const runDir = path.resolve(required(args, "run"));
  const timeScale = Number(args["time-scale"] ?? "20");
  const fixture = args.fixture ? path.resolve(args.fixture) : undefined;
  const profile = args.profile;
  const version = args.version ?? "unknown";

  if (!fs.existsSync(path.join(inputDir, "request.json"))) {
    throw new EvalError("INPUT_MISSING", `输入目录里没有 request.json：${inputDir}`);
  }
  if (!fs.existsSync(path.join(stateSnapshot, "system_config.yaml"))) {
    throw new EvalError("STATE_MISSING", `State 快照里没有 system_config.yaml：${stateSnapshot}`);
  }

  const layout = layoutOf(runDir);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(layout.runtimeDir, { recursive: true });

  const dbInit = initDatabase(layout.dbPath, { fixture, profile, timeScale });
  writeRunInterfacesConfig(layout.configPath, layout.dbPath);
  const staged = stageState(stateSnapshot, layout.dataRoot, {
    LR_RUNTIME_DIR: layout.runtimeDir,
    LR_INTERFACES_CONFIG: layout.configPath,
    LR_DATA_ROOT: layout.dataRoot,
  });

  // 必须在 import src 之前设置：paths.ts 在模块加载时就解析这些目录。
  process.env.LR_RUNTIME_DIR = layout.runtimeDir;
  process.env.LR_DATA_ROOT = layout.dataRoot;
  process.env.LR_INTERFACES_CONFIG = layout.configPath;
  process.env.LR_EXAMPLE_DIR = inputDir;
  process.env.LINE_RECOVERY_STATE_DB = layout.dbPath;

  const { loadExample, getCase } = await import("../src/case/store.ts");
  const { AnalysisError, analyzeCase, effectiveBaseUrl, modelId, modelProvider } = await import("../src/diagnosis/agent.ts");
  const { assembleReport, saveReport } = await import("../src/diagnosis/report.ts");
  const { latestAgentOutcome } = await import("../src/tools/decisions.ts");
  const { readAudit } = await import("../src/audit.ts");

  const thinkingLevel = (staged.config.model?.thinking_level ?? "medium") as string;
  const runtimeInfo = {
    provider: modelProvider(),
    model_id: modelId(),
    base_url: effectiveBaseUrl(),
    thinking_level: thinkingLevel,
    time_scale: timeScale,
    version,
  };

  // 案例装载：与页面"载入 example"同一条路径。
  loadExample();
  const view = getCase(caseId);
  if (view.parsed.caseId !== caseId) {
    throw new EvalError("CASE_MISMATCH", `输入目录的 case_id=${view.parsed.caseId}，与请求的 ${caseId} 不一致`);
  }

  const auditPath = path.join(layout.runtimeDir, "audit", `${caseId}.jsonl`);
  const reportPath = path.join(layout.runtimeDir, "reports", `${caseId}.json`);

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const events: Record<string, unknown>[] = [];
  const toolCalls: { name: string; state: string; detail?: string }[] = [];
  let text = "";
  let thinking = "";
  let sessionId: string | null = null;
  let model: { provider: string; modelId: string } | null = null;
  let runStatus: "ok" | "agent_output_invalid" | "infrastructure_failed" = "ok";
  let failureCode: string | null = null;
  let failureMessage: string | null = null;
  let reportValid: boolean | null = null;
  let reportIssues: unknown = null;

  const writeEvents = (): void => {
    fs.mkdirSync(layout.runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(layout.runDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""),
      "utf8",
    );
  };

  try {
    const result = await analyzeCase(view.parsed, view.facts, (event) => {
      events.push(event as Record<string, unknown>);
      if (event.type === "tool") toolCalls.push({ name: event.name, state: event.state, detail: event.detail });
      // 失败时 analyzeCase 不返回任何东西：在这里另行累积，保证"模型到底写了什么"仍然留证。
      if (event.type === "text") text += event.delta;
      if (event.type === "thinking") thinking += event.delta;
    });
    sessionId = result.sessionId;
    model = result.model;
    text = result.rawText;
    thinking = result.thinking;

    // 与 /analyze 一致：报告里的 recovery 只取自本轮诊断期间由受控工具发起的真实轨迹。
    const agentOutcome = latestAgentOutcome(caseId, startedAt);
    const stored = assembleReport({
      view,
      diagnosis: result.result,
      outcome: agentOutcome?.outcome ?? null,
      model,
      sessionId,
      rawText: text,
    });
    saveReport(stored);
    reportValid = stored.valid;
    reportIssues = stored.issues;
  } catch (error) {
    const code = error instanceof AnalysisError ? error.code : "ANALYSIS_FAILED";
    failureCode = code;
    failureMessage = (error as Error).message;
    // 模型请求本身失败 = 基础设施/外部配置问题；模型答得不对 = Agent 行为，仍然算一次有效运行。
    runStatus = code === "MODEL_REQUEST_FAILED" || code === "MODEL_AUTH_ERROR" || code === "MODEL_NOT_CONFIGURED" ? "infrastructure_failed" : "agent_output_invalid";
    events.push({ type: "error", code, message: failureMessage });
  }
  writeEvents();

  fs.writeFileSync(path.join(layout.runDir, "raw.json"), `${JSON.stringify({ text, thinking }, null, 2)}\n`, "utf8");

  const audit = readAudit(caseId);
  // 会话没跑完时 analyzeCase 不返回 sessionId；本 run 的目录是新建的，数据根下的 trace 全部属于这一例。
  const traces = findTraces(layout.dataRoot, sessionId ?? "");
  writeJson(path.join(layout.runDir, "run.json"), {
    case_id: caseId,
    version,
    status: runStatus,
    failure_code: failureCode,
    failure_message: failureMessage,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    runtime: runtimeInfo,
    session_id: sessionId,
    model,
    tool_calls: toolCalls,
    report: { path: path.relative(layout.runDir, reportPath), valid: reportValid, issues: reportIssues },
    audit: {
      path: path.relative(layout.runDir, auditPath),
      records: audit.length,
      phases: audit.map((r) => `${r.phase}/${r.actor}/${r.outcome}`),
    },
    traces: traces.map((t) => path.relative(layout.runDir, t)),
    database: { init: dbInit, path: layout.dbPath },
    case_input: { dir: inputDir, files: view.parsed.files, manifest_check: view.parsed.manifestCheck, parse_problems: view.parsed.parseProblems },
    state: { snapshot: stateSnapshot, files: hashTree(staged.stateDir) },
  });

  process.stdout.write(`${JSON.stringify({ case_id: caseId, status: runStatus, session_id: sessionId, duration_ms: Date.now() - startedMs })}\n`);
  if (runStatus === "infrastructure_failed") process.exitCode = 3;
}

await main().catch((error) => {
  const code = error instanceof EvalError ? error.code : "RUN_FAILED";
  process.stderr.write(`${code}: ${(error as Error).message}\n`);
  process.exitCode = 2;
});
