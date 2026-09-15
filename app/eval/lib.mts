/**
 * 评测入口的公共部分：把"一个案例一次运行"隔离成一个自足目录。
 *
 * 隔离目标（见 data/dataset/evaluator/README.md）：
 * - 每例一个独立设备数据库（夹具只在这里读入，绝不进 Agent 工作区）；
 * - 每例一份独立的 Agent State 副本（版本快照 → 运行目录，绝不改版本快照本身）；
 * - 每例独立的运行期目录（案例解包、工具审计、报告、会话 trace 都落在本 run 目录里）。
 *
 * 受控工具是 stdio MCP 子进程，SDK 只给它 HOME/PATH 之类的白名单环境变量
 * （见 penguin-core 的 StdioClientTransport 那一段），条目自带的 env 才是唯一通道。
 * 所以"本 run 用哪个 runtime、哪个接口配置"必须写进 State 副本的 tools.mcpServers[].config.env，
 * 数据库路径则按 interfaces/README.md 说的方式写在接口配置的 env 里。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const EVAL_DIR = path.resolve(import.meta.dirname);
export const APP_ROOT = path.resolve(EVAL_DIR, "..");
export const REPO_ROOT = path.resolve(APP_ROOT, "..");

export interface DatasetCase {
  case_id: string;
  split: string;
  input: string;
  input_manifest_sha256: string;
}

function datasetManifest(name: string): { data_source?: string; cases: DatasetCase[] } {
  const file = path.join(REPO_ROOT, "data", name, "split-manifest.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 子集使用自己的案例清单，但从 data_source 指定的数据集读取输入和评测材料。 */
export function datasetRoot(name: string): string {
  return path.join(REPO_ROOT, "data", datasetManifest(name).data_source ?? name);
}

export function datasetCases(name: string, split: string): DatasetCase[] {
  return datasetManifest(name).cases
    .filter((item) => item.split === split)
    .sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export class EvalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvalError";
    this.code = code;
  }
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (!key.startsWith("--")) throw new EvalError("BAD_ARGS", `无法识别的参数：${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new EvalError("BAD_ARGS", `参数 ${key} 缺少取值`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

export function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value?.trim()) throw new EvalError("BAD_ARGS", `缺少参数 --${key}`);
  return value.trim();
}

export interface RunLayout {
  runDir: string;
  runtimeDir: string;
  dataRoot: string;
  configPath: string;
  dbPath: string;
}

export function layoutOf(runDir: string): RunLayout {
  const dir = path.resolve(runDir);
  return {
    runDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    dataRoot: path.join(dir, "data"),
    configPath: path.join(dir, "config", "interfaces.json"),
    dbPath: path.join(dir, "state.sqlite3"),
  };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 目录内所有文件的相对路径 + 字节数 + sha256（用于固定"这次跑的到底是哪份输入/哪份 State"）。 */
export function hashTree(dir: string): { path: string; bytes: number; sha256: string }[] {
  const out: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".vault.toml" || entry.name === ".DS_Store") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        out.push({
          path: path.relative(dir, full).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 每例一个独立数据库：用组织方的夹具初始化，时间倍率固定。
 * 已存在的数据库一律拒绝覆盖（同一目录重复运行会如实报错，而不是把上一例的状态带过来）。
 */
export function initDatabase(
  dbPath: string,
  options: { fixture?: string; profile?: string; timeScale: number },
): Record<string, unknown> {
  if (fs.existsSync(dbPath)) {
    throw new EvalError("DB_EXISTS", `数据库已存在，不覆盖：${dbPath}`);
  }
  if (!options.fixture && !options.profile) {
    throw new EvalError("BAD_ARGS", "初始化数据库需要 --fixture 或 --profile 之一");
  }
  const args = [
    path.join(REPO_ROOT, "interfaces", "manage.py"),
    "--db",
    dbPath,
    "init",
    ...(options.fixture ? ["--fixture", path.resolve(options.fixture)] : ["--profile", options.profile!]),
    "--time-scale",
    String(options.timeScale),
  ];
  const result = spawnSync("python3", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new EvalError("DB_INIT_FAILED", `夹具装载失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** 本 run 的接口配置：与 app/config/interfaces.json 相同，只是把数据库路径写进两个服务的 env。 */
export function writeRunInterfacesConfig(configPath: string, dbPath: string): void {
  const base = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "config", "interfaces.json"), "utf8")) as {
    interfaces: Record<string, { env?: Record<string, string> }>;
    [key: string]: unknown;
  };
  for (const id of Object.keys(base.interfaces)) {
    const entry = base.interfaces[id]!;
    entry.env = { ...(entry.env ?? {}), LINE_RECOVERY_STATE_DB: dbPath };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
}

/**
 * 把版本快照里的 Agent State 复制成这一例的副本，并把"本 run 的绑定"写进 tools.mcpServers 的 env。
 * 只动运行副本；版本快照本身只读。
 */
export function stageState(
  stateSnapshotDir: string,
  dataRoot: string,
  relay: Record<string, string>,
): { stateDir: string; config: Record<string, any> } {
  const stateDir = path.join(dataRoot, "default_project", "agents", "default_agent", "agent_state");
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  fs.cpSync(stateSnapshotDir, stateDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".vault.toml",
  });
  const configPath = path.join(stateDir, "system_config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
  const servers = (config.tools?.mcpServers ?? []) as any[];
  if (!servers.length) throw new EvalError("STATE_NO_MCP", "State 副本里没有 tools.mcpServers：受控工具链路不完整");
  for (const server of servers) {
    server.config = { ...(server.config ?? {}), env: { ...(server.config?.env ?? {}), ...relay } };
  }
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { stateDir, config };
}

/** 会话 trace：SDK 写在数据根下的 traces/<日期>/<session_id>_*.jsonl。 */
export function findTraces(dataRoot: string, sessionId: string): string[] {
  const root = path.join(dataRoot, "default_project", "agents", "default_agent", "traces");
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes(sessionId)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
