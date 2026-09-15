/**
 * 案例目录解析：把一份上传资料读成结构化对象，并做结构与一致性核对。
 *
 * 只读不判：这里产出的都是"资料里写了什么"，不给出停机原因结论；
 * 原因判断属于 Agent 的诊断部分（见 src/diagnosis/）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TelemetryRow {
  timestamp: string;
  values: Record<string, number | boolean | string | null>;
}

export interface EventRow {
  event_id: string;
  timestamp: string;
  source: string;
  level: string;
  code: string;
  message: string;
}

export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestCheckEntry {
  path: string;
  status: "ok" | "missing" | "sha256_mismatch" | "size_mismatch" | "not_in_manifest";
  expectedSha256?: string;
  actualSha256?: string;
  expectedBytes?: number;
  actualBytes?: number;
}

export interface ManifestCheck {
  checked: number;
  problems: ManifestCheckEntry[];
  extraFiles: string[];
}

export interface CaseFiles {
  request: Record<string, any>;
  device: Record<string, any>;
  deviceState: Record<string, any>;
  dataDictionary: Record<string, any>;
  images: Record<string, any>;
  manifest: Record<string, any> | null;
  readme: string | null;
  operatingGuide: string | null;
  telemetryHeader: string[];
  telemetry: TelemetryRow[];
  events: EventRow[];
}

export interface ParsedCase extends CaseFiles {
  caseId: string;
  deviceId: string;
  dir: string;
  origin: "example" | "upload";
  files: FileEntry[];
  imageFiles: string[];
  manifestCheck: ManifestCheck;
  parseProblems: string[];
}

export const BOOLEAN_FIELDS = new Set([
  "controller_online",
  "upstream_power_available",
  "drive_power_enabled",
  "drive_ready",
  "run_command",
  "infeed_enabled",
  "production_requested",
  "emergency_stop_active",
  "maintenance_lockout",
  "guard_closed",
  "zone_clear",
  "downstream_ready",
  "unresolved_accumulation",
]);

export const STRING_FIELDS = new Set(["timestamp", "operating_mode"]);

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readJson(file: string, problems: string[]): Record<string, any> | null {
  if (!fs.existsSync(file)) {
    problems.push(`缺少文件：${path.basename(file)}`);
    return null;
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${path.basename(file)} 不是 JSON 对象`);
      return null;
    }
    return value as Record<string, any>;
  } catch (error) {
    problems.push(`${path.basename(file)} JSON 解析失败：${(error as Error).message}`);
    return null;
  }
}

function readText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** 极简 CSV（UTF-8、英文逗号、无引号包裹的字段内容；引号内逗号按 RFC4180 处理）。 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length > 0);
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [headerLine, ...rest] = lines;
  return { header: split(headerLine ?? ""), rows: rest.map(split) };
}

function coerce(field: string, raw: string): number | boolean | string | null {
  const value = raw.trim();
  if (value === "") return null; // 空值 = 未观测，不是 0/false
  if (STRING_FIELDS.has(field)) return value;
  if (BOOLEAN_FIELDS.has(field)) {
    if (value === "0") return false;
    if (value === "1") return true;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function walkFiles(dir: string, base = dir): FileEntry[] {
  const out: FileEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(full);
      out.push({ path: path.relative(base, full).split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function checkManifest(
  dir: string,
  manifest: Record<string, any> | null,
  files: FileEntry[],
  problems: string[],
): ManifestCheck {
  const check: ManifestCheck = { checked: 0, problems: [], extraFiles: [] };
  if (!manifest) {
    problems.push("缺少 manifest.json，无法核对输入完整性");
    return check;
  }
  const listed = Array.isArray(manifest.files) ? (manifest.files as Record<string, any>[]) : [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const listedPaths = new Set<string>();
  for (const item of listed) {
    const rel = String(item?.path ?? "");
    if (!rel) continue;
    listedPaths.add(rel);
    check.checked += 1;
    const actual = byPath.get(rel);
    if (!actual) {
      check.problems.push({ path: rel, status: "missing" });
      continue;
    }
    if (typeof item.bytes === "number" && item.bytes !== actual.bytes) {
      check.problems.push({
        path: rel,
        status: "size_mismatch",
        expectedBytes: item.bytes,
        actualBytes: actual.bytes,
      });
      continue;
    }
    if (typeof item.sha256 === "string" && item.sha256 !== actual.sha256) {
      check.problems.push({
        path: rel,
        status: "sha256_mismatch",
        expectedSha256: item.sha256,
        actualSha256: actual.sha256,
      });
    }
  }
  for (const file of files) {
    if (file.path === "manifest.json") continue;
    if (!listedPaths.has(file.path)) {
      check.extraFiles.push(file.path);
      check.problems.push({ path: file.path, status: "not_in_manifest" });
    }
  }
  return check;
}

/** 读取一个案例目录（上传解包目录或 examples/input）。 */
export function readCaseDir(dir: string, origin: "example" | "upload"): ParsedCase {
  const problems: string[] = [];
  const request = readJson(path.join(dir, "request.json"), problems) ?? {};
  const device = readJson(path.join(dir, "device.json"), problems) ?? {};
  const deviceState = readJson(path.join(dir, "device_state.json"), problems) ?? {};
  const dataDictionary = readJson(path.join(dir, "data_dictionary.json"), problems) ?? {};
  const images = readJson(path.join(dir, "images.json"), problems) ?? {};
  const manifest = readJson(path.join(dir, "manifest.json"), problems);
  const readme = readText(path.join(dir, "README.md"));
  const operatingGuide = readText(path.join(dir, "operating_guide.md"));

  let telemetryHeader: string[] = [];
  const telemetry: TelemetryRow[] = [];
  const csvPath = path.join(dir, "telemetry.csv");
  if (fs.existsSync(csvPath)) {
    const { header, rows } = parseCsv(fs.readFileSync(csvPath, "utf8"));
    telemetryHeader = header;
    for (const row of rows) {
      const values: Record<string, number | boolean | string | null> = {};
      header.forEach((field, i) => {
        values[field] = coerce(field, row[i] ?? "");
      });
      telemetry.push({ timestamp: String(values.timestamp ?? ""), values });
    }
  } else {
    problems.push("缺少文件：telemetry.csv");
  }

  const events: EventRow[] = [];
  const eventsPath = path.join(dir, "events.jsonl");
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, any>;
        events.push({
          event_id: String(raw.event_id ?? ""),
          timestamp: String(raw.timestamp ?? ""),
          source: String(raw.source ?? ""),
          level: String(raw.level ?? ""),
          code: String(raw.code ?? ""),
          message: String(raw.message ?? ""),
        });
      } catch {
        problems.push(`events.jsonl 有无法解析的行：${trimmed.slice(0, 60)}`);
      }
    }
  } else {
    problems.push("缺少文件：events.jsonl");
  }

  const files = walkFiles(dir);
  const imageFiles = files.filter((f) => f.path.startsWith("images/")).map((f) => f.path);
  const manifestCheck = checkManifest(dir, manifest, files, problems);

  return {
    caseId: String(request.case_id ?? "unknown"),
    deviceId: String(request.device_id ?? deviceState.device_id ?? "unknown"),
    dir,
    origin,
    request,
    device,
    deviceState,
    dataDictionary,
    images,
    manifest,
    readme,
    operatingGuide,
    telemetryHeader,
    telemetry,
    events,
    files,
    imageFiles,
    manifestCheck,
    parseProblems: problems,
  };
}
