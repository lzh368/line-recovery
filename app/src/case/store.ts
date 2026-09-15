/**
 * 案例存储：制作 example 与上传 ZIP 都落到 runtime/cases/<case_id>/，读取路径完全一致。
 * 仓库目录始终只读，不被写入。
 */
import fs from "node:fs";
import path from "node:path";
import { CASES_DIR, EXAMPLE_DIR, ensureDir } from "../paths.ts";
import { validate } from "./contracts.ts";
import { computeFacts, type Facts } from "./facts.ts";
import { readCaseDir, type ParsedCase } from "./parse.ts";
import { readZip, ZipError } from "./zip.ts";

export class InputError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "InputError";
    this.code = code;
    this.detail = detail;
  }
}

const INDEX_PATH = () => path.join(CASES_DIR, "index.json");

interface CaseMeta {
  caseId: string;
  deviceId: string;
  origin: "example" | "upload";
  label: string;
  loadedAt: string;
  sourceDir: string;
}

type CaseIndex = Record<string, CaseMeta>;

const REQUIRED_INPUT_FILES = [
  "request.json",
  "device.json",
  "device_state.json",
  "data_dictionary.json",
  "operating_guide.md",
  "telemetry.csv",
  "events.jsonl",
  "images.json",
];

function readIndex(): CaseIndex {
  const file = INDEX_PATH();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CaseIndex;
  } catch {
    return {};
  }
}

function writeIndex(index: CaseIndex): void {
  ensureDir(CASES_DIR);
  fs.writeFileSync(INDEX_PATH(), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function caseDir(caseId: string): string {
  return path.join(CASES_DIR, caseId);
}

export function listCases(): CaseMeta[] {
  return Object.values(readIndex()).sort((a, b) => a.loadedAt.localeCompare(b.loadedAt));
}

function register(meta: CaseMeta): void {
  const index = readIndex();
  index[meta.caseId] = meta;
  writeIndex(index);
}

export function removeCase(caseId: string): void {
  const index = readIndex();
  const meta = index[caseId];
  if (!meta) throw new InputError("CASE_NOT_FOUND", `案例 ${caseId} 不存在`);
  if (meta.origin === "example") {
    throw new InputError("CASE_IS_EXAMPLE", "example 是只读联调资料，不提供删除");
  }
  fs.rmSync(caseDir(caseId), { recursive: true, force: true });
  fs.rmSync(path.join(CASES_DIR, `${caseId}.audit.jsonl`), { force: true });
  delete index[caseId];
  writeIndex(index);
}

/** 载入仓库里的制作 example（复制到 runtime，仓库保持只读）。 */
export function loadExample(): CaseMeta {
  if (!fs.existsSync(path.join(EXAMPLE_DIR, "request.json"))) {
    throw new InputError("EXAMPLE_MISSING", `找不到 example 目录：${EXAMPLE_DIR}`);
  }
  const probe = readCaseDir(EXAMPLE_DIR, "example");
  const caseId = probe.caseId;
  const dir = caseDir(caseId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(EXAMPLE_DIR, dir, { recursive: true });
  const meta: CaseMeta = {
    caseId,
    deviceId: probe.deviceId,
    origin: "example",
    label: `example · ${caseId}`,
    loadedAt: new Date().toISOString(),
    sourceDir: EXAMPLE_DIR,
  };
  register(meta);
  return meta;
}

/** 接收上传 ZIP：解包、安全校验、契约校验后落盘。 */
export function uploadZip(buf: Buffer, label?: string): CaseMeta {
  let entries: { path: string; bytes: Buffer }[];
  try {
    entries = readZip(buf);
  } catch (error) {
    if (error instanceof ZipError) throw new InputError("ZIP_INVALID", error.message);
    throw error;
  }
  const byPath = new Map(entries.map((e) => [e.path, e.bytes]));
  const requestBytes = byPath.get("request.json");
  if (!requestBytes) {
    throw new InputError(
      "ZIP_LAYOUT",
      "ZIP 根目录必须直接包含 request.json（不嵌套外层目录），当前包内文件：" + entries.map((e) => e.path).join("、"),
    );
  }
  let request: Record<string, any>;
  try {
    request = JSON.parse(requestBytes.toString("utf8")) as Record<string, any>;
  } catch (error) {
    throw new InputError("REQUEST_INVALID", `request.json 解析失败：${(error as Error).message}`);
  }
  const requestValidation = validate("request.schema.json", request);
  if (!requestValidation.valid) {
    throw new InputError("REQUEST_INVALID", "request.json 不符合 contracts/request.schema.json", requestValidation.issues);
  }
  const missing = REQUIRED_INPUT_FILES.filter((f) => !byPath.has(f));
  if (missing.length) {
    throw new InputError("INPUT_INCOMPLETE", `压缩包缺少必需文件：${missing.join("、")}`);
  }
  const caseId = String(request.case_id);
  const dir = caseDir(caseId);
  if (fs.existsSync(dir) || readIndex()[caseId]) {
    throw new InputError("CASE_EXISTS", `案例 ${caseId} 已存在，请先删除后再上传（不会覆盖已有案例）`);
  }
  ensureDir(dir);
  for (const entry of entries) {
    const target = path.join(dir, entry.path);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, entry.bytes);
  }
  const parsed = readCaseDir(dir, "upload");
  if (parsed.parseProblems.some((p) => p.startsWith("缺少文件") || p.includes("解析失败"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new InputError("INPUT_UNREADABLE", "上传资料无法解析", parsed.parseProblems);
  }
  const meta: CaseMeta = {
    caseId,
    deviceId: parsed.deviceId,
    origin: "upload",
    label: label?.trim() ? label.trim() : `上传 · ${caseId}`,
    loadedAt: new Date().toISOString(),
    sourceDir: "uploaded_zip",
  };
  register(meta);
  return meta;
}

export interface CaseView {
  meta: CaseMeta;
  parsed: ParsedCase;
  facts: Facts;
  validations: {
    request: ReturnType<typeof validate>;
    deviceState: ReturnType<typeof validate>;
  };
}

/**
 * 案例是否带温控上下文：有温度报警样本或设备描述里带散热部分时，恢复输送还要核对
 * "无温控暂停 / 温度恢复条件合格"。Agent 的受控工具与页面按钮共用这一判定，避免两条路径不一致。
 */
export function hasThermalContext(view: CaseView): boolean {
  return (view.facts.temperature.samplesAtOrAboveWarning ?? 0) > 0 || Boolean(view.parsed.device?.cooling);
}

export function getCase(caseId: string): CaseView {
  const meta = readIndex()[caseId];
  if (!meta) throw new InputError("CASE_NOT_FOUND", `案例 ${caseId} 不存在`);
  const parsed = readCaseDir(caseDir(caseId), meta.origin);
  return {
    meta,
    parsed,
    facts: computeFacts(parsed),
    validations: {
      request: validate("request.schema.json", parsed.request),
      deviceState: validate("device-state.schema.json", parsed.deviceState),
    },
  };
}

/** 案例摘要（前端首屏用）：不返回整张 CSV，只给核对过的关键事实。 */
export function caseSummary(caseId: string): Record<string, unknown> {
  const view = getCase(caseId);
  const { meta, parsed, facts } = view;
  return {
    meta,
    request: parsed.request,
    device: parsed.device,
    snapshot: parsed.deviceState,
    facts,
    images: (parsed.images.frames ?? []) as Record<string, unknown>[],
    readme: parsed.readme,
    operatingGuide: parsed.operatingGuide,
    files: parsed.files,
    manifestCheck: parsed.manifestCheck,
    parseProblems: parsed.parseProblems,
    counts: {
      telemetryRows: parsed.telemetry.length,
      events: parsed.events.length,
      images: parsed.imageFiles.length,
      files: parsed.files.length,
    },
    validations: view.validations,
  };
}
