/**
 * HTTP 服务：静态前端 + JSON API。
 *
 * 边界约定：
 * - 诊断（/analyze）由嵌入式 Agent 产生，流式返回；
 * - 动作（/recovery）只由后端经 MCP 客户端执行，结果写进审计；
 * - 工具未连接时接口如实返回未连接，不产生任何设备动作，也不编造反馈。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { APP_ROOT, CONTRACTS_DIR, DEFAULT_PORT, ENV_FILE, EXAMPLE_DIR, HOST, INTERFACES_CONFIG_PATH, INTERFACES_DIR, RUNTIME_DIR, pickPort } from "./paths.ts";
import { contractFiles } from "./case/contracts.ts";
import { InputError, caseSummary, getCase, hasThermalContext, listCases, loadExample, removeCase, uploadZip } from "./case/store.ts";
import { AnalysisError, DEFAULT_MODEL_BASE_URL, analyzeCase, effectiveBaseUrl, modelId, modelKeyEnv, modelProvider, probeModel } from "./diagnosis/agent.ts";
import { assembleReport, clearReport, readReport, saveReport } from "./diagnosis/report.ts";
import { clearAudit, readAudit } from "./audit.ts";
import { latestAgentOutcome } from "./tools/decisions.ts";
import { INTERFACES, connect, disconnect, executionMode, statusList, type InterfaceId } from "./tools/registry.ts";
import { runRecovery, type RecoveryAction } from "./tools/recovery.ts";

const PUBLIC_DIR = path.join(APP_ROOT, "public");
const VERSION = "0.1.0";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".csv": "text/csv; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof InputError) {
    const notFound = error.code === "CASE_NOT_FOUND" || error.code === "REPORT_NOT_FOUND" || error.code === "FILE_NOT_FOUND";
    const status = notFound ? 404 : 400;
    sendJson(res, status, { error: error.code, message: error.message, detail: error.detail ?? null });
    return;
  }
  if (error instanceof AnalysisError) {
    const status = error.code === "MODEL_NOT_CONFIGURED" || error.code === "MODEL_AUTH_ERROR" ? 503 : 502;
    sendJson(res, status, { error: error.code, message: error.message, detail: error.detail ?? null });
    return;
  }
  sendJson(res, 500, { error: "INTERNAL", message: (error as Error).message });
}

async function readBody(req: http.IncomingMessage, limit = 40 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new InputError("BODY_TOO_LARGE", `请求体超过上限 ${limit} 字节`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as Record<string, any>;
  } catch {
    throw new InputError("BODY_INVALID", "请求体不是合法 JSON");
  }
}

/** HTTP 头只能是 ASCII：案例名由前端 encodeURIComponent 编码后放在 x-case-label 里。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assertInterfaceId(value: string): InterfaceId {
  if (value === "power-control" || value === "cooling-control") return value;
  throw new InputError("INTERFACE_UNKNOWN", `未知接口：${value}`);
}

/** 案例内文件读取：只允许案例目录内的普通文件。 */
function caseFile(caseId: string, rel: string): { file: string; bytes: Buffer } {
  const view = getCase(caseId);
  const base = view.parsed.dir;
  const target = path.normalize(path.join(base, rel));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new InputError("PATH_ESCAPE", "只能读取案例目录内的文件");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new InputError("FILE_NOT_FOUND", `案例内不存在文件：${rel}`);
  }
  return { file: target, bytes: fs.readFileSync(target) };
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(target));
}

async function handleAnalyze(req: http.IncomingMessage, res: http.ServerResponse, caseId: string): Promise<void> {
  const view = getCase(caseId);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (payload: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const startedAt = new Date().toISOString();
  try {
    const { result, rawText, sessionId, model, thinking } = await analyzeCase(
      view.parsed,
      view.facts,
      (event) => write(event),
      abort.signal,
    );
    // 报告里的 recovery 必须来自真实工具轨迹：只认本轮诊断期间由受控工具发起的恢复结果。
    const agentOutcome = latestAgentOutcome(caseId, startedAt);
    const stored = assembleReport({
      view,
      diagnosis: result,
      outcome: agentOutcome?.outcome ?? readReport(caseId)?.recovery_outcome ?? null,
      model,
      sessionId,
      rawText,
      createdAt: readReport(caseId)?.created_at,
    });
    const previous = readReport(caseId);
    saveReport(stored);
    write({
      type: "report",
      report: stored.report,
      valid: stored.valid,
      issues: stored.issues,
      recovery_plan: stored.recovery_plan,
      model,
      sessionId,
      thinking_length: thinking.length,
      replaced_previous: Boolean(previous),
      agent_outcome: agentOutcome ? { action: agentOutcome.action, at: agentOutcome.at, status: agentOutcome.outcome.status } : null,
    });
  } catch (error) {
    const code = error instanceof AnalysisError ? error.code : "ANALYSIS_FAILED";
    write({ type: "error", code, message: (error as Error).message, detail: (error as any)?.detail ?? null });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  const segments = pathname.split("/").filter(Boolean);

  if (!pathname.startsWith("/api/")) {
    serveStatic(res, pathname);
    return;
  }

  // ── 基础信息 ─────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      app: "产线恢复助手",
      version: VERSION,
      runtime_dir: RUNTIME_DIR,
      contracts_dir: CONTRACTS_DIR,
      contracts: contractFiles(),
      interfaces_dir: INTERFACES_DIR,
      interfaces_config: INTERFACES_CONFIG_PATH,
      example_dir: EXAMPLE_DIR,
      execution_mode: executionMode(),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/model") {
    const probe = await probeModel();
    sendJson(res, 200, {
      ...probe,
      pinned_provider: modelProvider(),
      pinned_model_id: modelId(),
      default_base_url: DEFAULT_MODEL_BASE_URL,
      // 这三项都可以在 app/.env 里改；*_set 说明当前值是不是由那个文件（或 shell）给的。
      model_env: {
        provider_key: "LR_MODEL_PROVIDER",
        model_id_key: "LR_MODEL_ID",
        base_url_key: "DEEPSEEK_BASE_URL",
        provider_set: Boolean(process.env.LR_MODEL_PROVIDER?.trim()),
        model_id_set: Boolean(process.env.LR_MODEL_ID?.trim()),
        base_url_set: Boolean(process.env.DEEPSEEK_BASE_URL?.trim()),
      },
      env_file: ENV_FILE,
      env_file_exists: fs.existsSync(ENV_FILE),
      data_root: path.join(APP_ROOT, "penguin_data"),
      note: probe.configured
        ? "嵌入式 Agent 的模型已就绪"
        : "未配置模型：诊断不可用（上传资料浏览、工具状态与审计不受影响）",
    });
    return;
  }

  if (method === "GET" && pathname === "/api/tools") {
    sendJson(res, 200, {
      execution_mode: executionMode(),
      config_path: INTERFACES_CONFIG_PATH,
      interfaces_dir: INTERFACES_DIR,
      interfaces: statusList(),
    });
    return;
  }

  if (method === "POST" && segments[1] === "tools" && segments[2] && segments[3]) {
    const id = assertInterfaceId(segments[2]);
    if (segments[3] === "connect") {
      sendJson(res, 200, { interface: await connect(id) });
      return;
    }
    if (segments[3] === "disconnect") {
      sendJson(res, 200, { interface: await disconnect(id) });
      return;
    }
  }

  // ── 案例 ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/cases") {
    sendJson(res, 200, { cases: listCases() });
    return;
  }

  if (method === "POST" && pathname === "/api/cases/load-example") {
    const meta = loadExample();
    clearAudit(meta.caseId);
    clearReport(meta.caseId);
    sendJson(res, 200, { case: meta });
    return;
  }

  if (method === "POST" && pathname === "/api/cases/upload") {
    const buf = await readBody(req);
    if (!buf.length) throw new InputError("ZIP_EMPTY", "上传内容为空");
    const rawLabel = req.headers["x-case-label"];
    const label = typeof rawLabel === "string" && rawLabel.trim() ? safeDecode(rawLabel) : undefined;
    const meta = uploadZip(buf, label);
    sendJson(res, 200, { case: meta });
    return;
  }

  if (segments[1] === "cases" && segments[2]) {
    const caseId = decodeURIComponent(segments[2]);
    const tail = segments[3];

    if (method === "DELETE" && !tail) {
      removeCase(caseId);
      clearAudit(caseId);
      clearReport(caseId);
      sendJson(res, 200, { removed: caseId });
      return;
    }

    if (method === "GET" && !tail) {
      sendJson(res, 200, caseSummary(caseId));
      return;
    }

    if (method === "GET" && tail === "telemetry") {
      const view = getCase(caseId);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 500)));
      sendJson(res, 200, {
        header: view.parsed.telemetryHeader,
        total: view.parsed.telemetry.length,
        offset,
        limit,
        rows: view.parsed.telemetry.slice(offset, offset + limit),
      });
      return;
    }

    if (method === "GET" && tail === "events") {
      const view = getCase(caseId);
      sendJson(res, 200, { events: view.parsed.events });
      return;
    }

    if (method === "GET" && tail === "audit") {
      sendJson(res, 200, { audit: readAudit(caseId), execution_mode: executionMode() });
      return;
    }

    if (method === "GET" && tail === "report") {
      const stored = readReport(caseId);
      if (!stored) throw new InputError("REPORT_NOT_FOUND", "还没有报告：先执行诊断");
      sendJson(res, 200, stored);
      return;
    }

    if (method === "GET" && tail === "file") {
      const rel = url.searchParams.get("path") ?? "";
      const { file, bytes } = caseFile(caseId, rel);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }

    if (method === "POST" && tail === "analyze") {
      await handleAnalyze(req, res, caseId);
      return;
    }

    if (method === "POST" && tail === "recovery") {
      const body = await readJsonBody(req);
      const action = String(body.action ?? "");
      if (action !== "resume_conveyor" && action !== "start_cooling") {
        throw new InputError("ACTION_UNKNOWN", "action 只能是 resume_conveyor 或 start_cooling");
      }
      const view = getCase(caseId);
      const outcome = await runRecovery(caseId, action as RecoveryAction, { hasThermalContext: hasThermalContext(view) });
      const stored = readReport(caseId);
      if (stored) {
        const next = assembleReport({
          view,
          diagnosis: { diagnosis: stored.report.diagnosis as Record<string, unknown>, recovery_plan: stored.recovery_plan ?? { decision: "insufficient_evidence", preferred_action: null, reason: "" }, limitations: (stored.report.limitations as string[]) ?? [] },
          outcome,
          model: stored.model,
          sessionId: stored.session_id,
          rawText: stored.raw_model_output ?? "",
          createdAt: stored.created_at,
        });
        saveReport(next);
        sendJson(res, 200, { outcome, report: next.report, valid: next.valid, issues: next.issues });
        return;
      }
      sendJson(res, 200, {
        outcome,
        report: null,
        note: "尚未执行诊断，报告未生成；动作结果只记录在审计里。",
      });
      return;
    }
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "NOT_FOUND", message: `${method} ${pathname} 不存在` }));
}

/** 供测试与启动脚本复用：创建一个监听指定端口的服务。 */
export function createServer(): http.Server {
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
    });
  });
  return server;
}

export async function start(port = DEFAULT_PORT): Promise<http.Server> {
  const actual = await pickPort(port);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(actual, HOST, resolve));
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const server = await start();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
  process.stdout.write(`产线恢复助手已启动： http://${HOST}:${port}\n`);
  process.stdout.write(`契约目录： ${CONTRACTS_DIR}\n`);
  process.stdout.write(`接口配置： ${INTERFACES_CONFIG_PATH}\n`);
  const statuses = statusList();
  for (const s of statuses) {
    process.stdout.write(`工具 ${s.id}： ${s.connectionLabel}${s.serviceCommand ? `（${s.serviceCommand}）` : ""}\n`);
  }
  const probe = await probeModel();
  process.stdout.write(`模型： ${modelProvider()} / ${modelId()} @ ${effectiveBaseUrl()}（密钥：${modelKeyEnv()}，来源 app/.env 或环境变量）\n`);
  process.stdout.write(
    probe.configured
      ? `模型状态： 已就绪${probe.api_key_present ? "" : "（未读到密钥，实际调用可能失败）"}\n`
      : `模型状态： 未配置 —— 诊断不可用，其余功能正常（${probe.error ?? "无模型信息"}）\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

export { INTERFACES };
