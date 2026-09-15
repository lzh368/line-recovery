/**
 * 契约校验：直接加载仓库 contracts/ 下的 JSON Schema 2020-12 文件，
 * 相对 `$ref`（report → action-result / device-state）按本目录文件名解析，不访问网络。
 *
 * 结构合法不等于事实正确（contracts/README.md）：这里只做结构与格式校验，
 * 设备绑定、时间新鲜度、真实工具轨迹由后端另行核对。
 */
import fs from "node:fs";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { CONTRACTS_DIR } from "../paths.ts";

/** ajv-formats 是 CJS 的单函数导出，这里按运行时形状收窄以保持类型检查干净。 */
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020, options?: unknown) => Ajv2020;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const SCHEMA_FILES = [
  "request.schema.json",
  "device-state.schema.json",
  "action-result.schema.json",
  "report.schema.json",
] as const;

export type SchemaName = (typeof SCHEMA_FILES)[number];

let validators: Map<string, ValidateFunction> | null = null;

function build(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  const map = new Map<string, ValidateFunction>();
  for (const file of SCHEMA_FILES) {
    const full = path.join(CONTRACTS_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`缺少契约文件：${full}`);
    const schema = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
    // 用文件名注册：report.schema.json 内的 "action-result.schema.json" 相对 $ref 由此解析。
    ajv.addSchema(schema, file);
  }
  for (const file of SCHEMA_FILES) {
    const compiled = ajv.getSchema(file);
    if (!compiled) throw new Error(`契约编译失败：${file}`);
    map.set(file, compiled);
  }
  return map;
}

function get(name: SchemaName): ValidateFunction {
  if (!validators) validators = build();
  const fn = validators.get(name);
  if (!fn) throw new Error(`未加载契约：${name}`);
  return fn;
}

export function validate(schema: SchemaName, value: unknown): ValidationResult {
  const fn = get(schema);
  const valid = fn(value) as boolean;
  const issues: ValidationIssue[] = valid
    ? []
    : (fn.errors ?? []).map((e) => ({
        path: e.instancePath || "/",
        message: `${e.message ?? "校验失败"}${e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ""}`,
      }));
  return { valid, issues };
}

/** 报告模板只用于展示字段布局，不是答案；这里只读取它做占位提示。 */
export function reportTemplate(): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, "report.template.json"), "utf8"));
}

export function contractFiles(): { file: string; bytes: number }[] {
  return SCHEMA_FILES.map((file) => ({
    file,
    bytes: fs.statSync(path.join(CONTRACTS_DIR, file)).size,
  }));
}
