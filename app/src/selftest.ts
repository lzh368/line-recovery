/**
 * 自检（npm run check）：用真实 HTTP 请求跑一遍应用的主链路。
 *
 * 覆盖：契约加载 → example 解析与核对 → 事实提取 → 各 API 端点 → 工具未连接时的
 * 诚实降级（不产生动作、不产生报告）→ ZIP 上传成功与恶意包被拒 → 清理临时数据。
 * 任何一项不通过都会以非 0 退出码结束。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { EXAMPLE_DIR, REPORTS_DIR, RUNTIME_DIR, ensureDir } from "./paths.ts";
import { readCaseDir } from "./case/parse.ts";
import { computeFacts } from "./case/facts.ts";
import { validate } from "./case/contracts.ts";
import { clearAudit } from "./audit.ts";
import { clearReport } from "./diagnosis/report.ts";
import { createServer } from "./server.ts";

/* ── 断言记录 ─────────────────────────────────────────────────────────── */
const results: { group: string; name: string; ok: boolean; detail: string }[] = [];
let group = "";

function check(name: string, condition: boolean, detail: unknown = ""): void {
  results.push({ group, name, ok: Boolean(condition), detail: detail === "" ? "" : typeof detail === "string" ? detail : JSON.stringify(detail) });
}

function section(title: string): void {
  group = title;
  process.stdout.write(`\n▸ ${title}\n`);
}

function suite(title: string, fn: () => void | Promise<void>): Promise<void> {
  section(title);
  return Promise.resolve()
    .then(fn)
    .catch((error: unknown) => {
      check("用例未抛出异常", false, (error as Error).message);
    });
}

/* ── 极简 ZIP 写入器（仅自检用，用来验证上传路径） ─────────────────────── */
interface ZipInput {
  path: string;
  bytes: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = file.bytes;
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function readZipInputs(dir: string, base = dir): ZipInput[] {
  const out: ZipInput[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readZipInputs(full, base));
    else out.push({ path: path.relative(base, full).split(path.sep).join("/"), bytes: fs.readFileSync(full) });
  }
  return out;
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
const WORK = ensureDir(path.join(RUNTIME_DIR, "selftest"));
// request.schema.json 要求 case_id 形如 lr_NNN
const UPLOAD_CASE_ID = "lr_999";
let base = "";
const json = async (pathname: string, init?: RequestInit) => {
  const res = await fetch(base + pathname, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as { status: number; body: any };
};

async function main(): Promise<void> {
  await suite("契约加载", () => {
    const bad = validate("report.schema.json", {});
    check("report.schema.json 能编译并拒绝空对象", bad.valid === false);
    const request = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, "request.json"), "utf8"));
    check("example 的 request.json 通过契约", validate("request.schema.json", request).valid);
    const snapshot = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, "device_state.json"), "utf8"));
    check("example 的 device_state.json 通过契约", validate("device-state.schema.json", snapshot).valid);
  });

  await suite("example 解析与事实核对", () => {
    const parsed = readCaseDir(EXAMPLE_DIR, "example");
    const facts = computeFacts(parsed);
    check("case_id = lr_001", parsed.caseId === "lr_001", parsed.caseId);
    check("device_id = CV-01", parsed.deviceId === "CV-01", parsed.deviceId);
    check("时序 121 行", parsed.telemetry.length === 121, parsed.telemetry.length);
    check("日志 14 条", parsed.events.length === 14, parsed.events.length);
    check("parseProblems 为空", parsed.parseProblems.length === 0, parsed.parseProblems);
    check("manifest 无问题", parsed.manifestCheck.problems.length === 0, parsed.manifestCheck.problems);
    check("图片 1 张", parsed.imageFiles.length === 1, parsed.imageFiles);
    check("供电丢失于 09:00:40", (facts.power.lostAt ?? "").includes("09:00:40"), facts.power.lostAt);
    check("供电恢复于 09:01:10", (facts.power.restoredAt ?? "").includes("09:01:10"), facts.power.restoredAt);
    check("驱动就绪恢复于 09:01:12", (facts.power.driveReadyBackAt ?? "").includes("09:01:12"), facts.power.driveReadyBackAt);
    check("带速停稳于 09:00:42", (facts.motion.stoppedAt ?? "").includes("09:00:42"), facts.motion.stoppedAt);
    check(
      "运行请求在 09:00:40 由 true 变 false（断电那一刻）",
      facts.runCommand.transitions.length === 1 &&
        facts.runCommand.transitions[0]!.from === true &&
        facts.runCommand.transitions[0]!.to === false &&
        facts.runCommand.transitions[0]!.at.includes("09:00:40"),
      facts.runCommand.transitions,
    );
    check("末态仍无运行请求", facts.runCommand.endValue === false, facts.runCommand.endValue);
    check("入口计数末值 1022", facts.counters.infeed.last === 1022, facts.counters.infeed);
    check("出口计数末值 1019", facts.counters.outfeed.last === 1019, facts.counters.outfeed);
    check("人工移出 0", facts.counters.manualRemoved.last === 0, facts.counters.manualRemoved);
    check("在制 3 箱", facts.counters.workInProgress === 3, facts.counters.workInProgress);
    check("快照与 CSV 末行无可对照差异", facts.snapshotVsCsvEnd.length === 0, facts.snapshotVsCsvEnd);
    check("快照 source = uploaded_snapshot", facts.snapshot.source === "uploaded_snapshot", facts.snapshot.source);
  });

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  try {
    await suite("基础 API", async () => {
      const health = await json("/api/health");
      check("GET /api/health 返回 ok", health.status === 200 && health.body.ok === true, health.body);
      check("契约目录指向仓库 contracts/", String(health.body.contracts_dir).endsWith("contracts"), health.body.contracts_dir);
      const tools = await json("/api/tools");
      const labels = (tools.body.interfaces ?? []).map((i: any) => i.connectionLabel);
      check("两个接口都已注册", (tools.body.interfaces ?? []).length === 2, tools.body.interfaces?.map((i: any) => i.id));
      check("未配置服务时状态是“工具未连接”", labels.every((l: string) => l === "工具未连接"), labels);
      check("执行模式来自配置且默认 dry_run", tools.body.execution_mode === "dry_run", tools.body.execution_mode);
      const model = await json("/api/model");
      check("GET /api/model 如实返回模型状态", typeof model.body.configured === "boolean", model.body);
      const expectedProvider = process.env.LR_MODEL_PROVIDER?.trim() || "deepseek";
      const expectedModelId = process.env.LR_MODEL_ID?.trim() || "deepseek-flash";
      check(
        "模型是 deepseek / deepseek-flash（DeepSeek V4.1 Flash），且随 app/.env 里的变量走",
        model.body.pinned_provider === expectedProvider && model.body.pinned_model_id === expectedModelId,
        { pinned: `${model.body.pinned_provider} / ${model.body.pinned_model_id}`, env: { LR_MODEL_PROVIDER: process.env.LR_MODEL_PROVIDER ?? null, LR_MODEL_ID: process.env.LR_MODEL_ID ?? null } },
      );
      const envBlock = model.body.model_env ?? {};
      check(
        "模型三项都能在 app/.env 里改（接口报变量名和来源）",
        envBlock.provider_key === "LR_MODEL_PROVIDER" &&
          envBlock.model_id_key === "LR_MODEL_ID" &&
          envBlock.base_url_key === "DEEPSEEK_BASE_URL" &&
          envBlock.provider_set === Boolean(process.env.LR_MODEL_PROVIDER?.trim()) &&
          envBlock.model_id_set === Boolean(process.env.LR_MODEL_ID?.trim()) &&
          envBlock.base_url_set === Boolean(process.env.DEEPSEEK_BASE_URL?.trim()),
        envBlock,
      );
      check(
        "密钥变量由提供方推导成 DEEPSEEK_API_KEY，且“是否读到”与环境一致",
        model.body.provider_env_key === `${expectedProvider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY` &&
          model.body.api_key_present === Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
        { env_key: model.body.provider_env_key, present: model.body.api_key_present },
      );
      const modelPayload = JSON.stringify(model.body);
      check(
        "接口不回传密钥内容",
        !process.env.DEEPSEEK_API_KEY || !modelPayload.includes(process.env.DEEPSEEK_API_KEY),
      );
      check(
        "空密钥不再报“已就绪”（不靠建会话判断）",
        model.body.api_key_present ? true : model.body.configured === false,
        { present: model.body.api_key_present, configured: model.body.configured },
      );
      check(
        "接口报告的端点与配置一致",
        model.body.base_url === (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"),
        model.body.base_url,
      );
      process.stdout.write(
        `  · 模型：${model.body.configured ? `已就绪（${model.body.provider} / ${model.body.modelId}）` : `未配置（${model.body.error}）`}；密钥 ${model.body.api_key_present ? "已读到" : "未读到"}\n`,
      );
    });

    await suite("案例载入与读取", async () => {
      const loaded = await json("/api/cases/load-example", { method: "POST" });
      check("POST /api/cases/load-example 成功", loaded.status === 200 && loaded.body.case.caseId === "lr_001", loaded.body);
      const list = await json("/api/cases");
      check("案例列表含 lr_001", (list.body.cases ?? []).some((c: any) => c.caseId === "lr_001"));
      const summary = await json("/api/cases/lr_001");
      check("案例摘要含 121 行时序", summary.body.counts.telemetryRows === 121, summary.body.counts);
      check("request 契约校验通过", summary.body.validations.request.valid === true);
      check("device_state 契约校验通过", summary.body.validations.deviceState.valid === true);
      const telemetry = await json("/api/cases/lr_001/telemetry?limit=500");
      check("时序端点返回 121 行", telemetry.body.rows.length === 121, telemetry.body.total);
      check("时序首行字段完整", Object.keys(telemetry.body.rows[0].values).length === telemetry.body.header.length);
      const events = await json("/api/cases/lr_001/events");
      check("日志端点返回 14 条", events.body.events.length === 14);
      const missing = await json("/api/cases/lr_001/report");
      check("没有报告时如实返回 REPORT_NOT_FOUND", missing.status === 404 && missing.body.error === "REPORT_NOT_FOUND", missing.body);
      const image = await fetch(`${base}/api/cases/lr_001/file?path=${encodeURIComponent("images/frame_001.png")}`);
      const imageBytes = Buffer.from(await image.arrayBuffer());
      check("案例内图片可读取且是 PNG", image.ok && imageBytes.subarray(1, 4).toString() === "PNG", imageBytes.length);
      const escape = await json(`/api/cases/lr_001/file?path=${encodeURIComponent("../../../../etc/passwd")}`);
      check("越界路径被拒绝", escape.status === 400 && escape.body.error === "PATH_ESCAPE", escape.body);
    });

    await suite("工具未连接时的诚实降级", async () => {
      const auditBefore = await json("/api/cases/lr_001/audit");
      const before = auditBefore.body.audit.length;
      const recovery = await json("/api/cases/lr_001/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume_conveyor" }),
      });
      const outcome = recovery.body.outcome;
      check("请求恢复返回 200", recovery.status === 200, recovery.body);
      check("未执行任何动作（attempted=false）", outcome.attempted === false, outcome.attempted);
      check("阶段是 not_attempted", outcome.status === "not_attempted", outcome.status);
      check("operations 为空", Array.isArray(outcome.operations) && outcome.operations.length === 0, outcome.operations);
      check("latest_state 为 null（不沿用上传快照）", outcome.latest_state === null, outcome.latest_state);
      check("决策为 human_required", outcome.decision === "human_required", outcome.decision);
      check("原因码 TOOLS_UNAVAILABLE", outcome.reason_code === "TOOLS_UNAVAILABLE", outcome.reason_code);
      const auditAfter = await json("/api/cases/lr_001/audit");
      check("审计新增一条记录", auditAfter.body.audit.length === before + 1, auditAfter.body.audit.length);
      const last = auditAfter.body.audit[auditAfter.body.audit.length - 1];
      check("审计记录 phase=blocked / outcome=TOOLS_UNAVAILABLE", last.phase === "blocked" && last.outcome === "TOOLS_UNAVAILABLE", last);
      check("审计里没有 request_id（没有发出写调用）", last.request_id === null, last.request_id);

      const analyze = await fetch(`${base}/api/cases/lr_001/analyze`, { method: "POST" });
      const text = await analyze.text();
      const events = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => {
          try {
            return JSON.parse(line.slice(5).trim());
          } catch {
            return null;
          }
        })
        .filter(Boolean) as any[];
      const reportEvent = events.find((e) => e.type === "report");
      const errorEvent = events.find((e) => e.type === "error");
      const modelConfigured = (await json("/api/model")).body.configured;
      if (modelConfigured) {
        check("模型已配置：诊断产出报告或如实报错", Boolean(reportEvent) || Boolean(errorEvent), events.map((e) => e.type));
        if (reportEvent) {
          check("报告满足 report.schema.json", reportEvent.valid === true, reportEvent.issues);
          check("未执行动作时 recovery.operations 为空", reportEvent.report.recovery.operations.length === 0);
          check("未执行动作时 recovery.latest_state 为 null", reportEvent.report.recovery.latest_state === null);
          check("recovery.status = not_attempted", reportEvent.report.recovery.status === "not_attempted", reportEvent.report.recovery.status);
        }
      } else {
        check("未配置模型：诊断不产出报告", reportEvent === undefined, reportEvent);
        check("未配置模型：返回 MODEL_NOT_CONFIGURED", errorEvent && errorEvent.code === "MODEL_NOT_CONFIGURED", errorEvent);
      }
    });

    await suite("ZIP 上传（成功与拒绝）", async () => {
      // 1) 从 examples/input 造一个包，改 case_id 以免与 example 重名
      const tmp = ensureDir(path.join(WORK, "zip-src"));
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(EXAMPLE_DIR, tmp, { recursive: true });
      const request = JSON.parse(fs.readFileSync(path.join(tmp, "request.json"), "utf8"));
      request.case_id = UPLOAD_CASE_ID;
      fs.writeFileSync(path.join(tmp, "request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
      const zip = makeZip(readZipInputs(tmp));
      const uploaded = await fetch(`${base}/api/cases/upload`, {
        method: "POST",
        headers: { "x-case-label": encodeURIComponent("自检上传包") },
        body: new Uint8Array(zip),
      });
      const uploadBody = await uploaded.json();
      check("上传成功并返回案例", uploaded.status === 200 && uploadBody.case.caseId === UPLOAD_CASE_ID, uploadBody);
      const summary = await json(`/api/cases/${UPLOAD_CASE_ID}`);
      check("上传案例可读且时序 121 行", summary.body.counts.telemetryRows === 121, summary.body.counts);
      check(
        "manifest 如实报告被改动的 request.json",
        summary.body.manifestCheck.problems.length === 1 && summary.body.manifestCheck.problems[0].path === "request.json",
        summary.body.manifestCheck.problems,
      );

      // 2) 缺少 request.json 的包
      const noRequest = makeZip([{ path: "device.json", bytes: Buffer.from("{}") }]);
      const bad1 = await fetch(`${base}/api/cases/upload`, { method: "POST", body: new Uint8Array(noRequest) });
      const bad1Body = await bad1.json();
      check("缺少 request.json 的包被拒绝", bad1.status === 400 && bad1Body.error === "ZIP_LAYOUT", bad1Body);

      // 3) 路径穿越的包
      const escapeZip = makeZip([{ path: "../evil.txt", bytes: Buffer.from("x") }]);
      const bad2 = await fetch(`${base}/api/cases/upload`, { method: "POST", body: new Uint8Array(escapeZip) });
      const bad2Body = await bad2.json();
      check("含 ../ 的包被拒绝", bad2.status === 400 && bad2Body.error === "ZIP_INVALID", bad2Body);

      // 4) 缺必需文件的包
      const incomplete = makeZip([{ path: "request.json", bytes: Buffer.from(JSON.stringify(request)) }]);
      const bad3 = await fetch(`${base}/api/cases/upload`, { method: "POST", body: new Uint8Array(incomplete) });
      const bad3Body = await bad3.json();
      check("缺必需文件的包被拒绝", bad3.status === 400 && bad3Body.error === "INPUT_INCOMPLETE", bad3Body);

      // 5) 上传案例可删除，example 不可删除
      const removed = await json(`/api/cases/${UPLOAD_CASE_ID}`, { method: "DELETE" });
      check("上传案例可删除", removed.status === 200, removed.body);
      const removeExample = await json("/api/cases/lr_001", { method: "DELETE" });
      check("example 案例不提供删除", removeExample.status === 400 && removeExample.body.error === "CASE_IS_EXAMPLE", removeExample.body);
    });
  } finally {
    // 自检产生的运行期数据全部清掉，用户首次打开时是干净状态
    clearAudit("lr_001");
    clearReport("lr_001");
    fs.rmSync(path.join(WORK, "zip-src"), { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /* ── 汇总 ─────────────────────────────────────────────────────────────── */
  let currentGroup = "";
  let failures = 0;
  for (const item of results) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      process.stdout.write(`\n${currentGroup}\n`);
    }
    if (!item.ok) failures += 1;
    process.stdout.write(`  ${item.ok ? "✓" : "✗"} ${item.name}${item.ok || !item.detail ? "" : ` —— ${item.detail}`}\n`);
  }
  process.stdout.write(`\n共 ${results.length} 项，通过 ${results.length - failures} 项，失败 ${failures} 项。\n`);
  process.stdout.write(`（未配置模型 / 未连接工具时的行为已按“如实降级”检查；报告目录：${REPORTS_DIR}）\n`);
  if (failures) process.exitCode = 1;
}

await main();
