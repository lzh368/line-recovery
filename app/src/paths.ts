/**
 * 路径解析：应用自带数据放在 app/ 内，仓库共享资料（contracts / interfaces / examples）从仓库根读。
 * 所有路径都基于本文件位置解析，整个 app/ 目录可以整体拷贝到别处继续运行。
 */
import fs from "node:fs";
import path from "node:path";

export const APP_ROOT = path.resolve(import.meta.dirname, "..");
export const REPO_ROOT = path.resolve(APP_ROOT, "..");

function dirFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? path.resolve(value) : fallback;
}

/** 契约目录（只读）：Schema 与报告模板。 */
export const CONTRACTS_DIR = dirFromEnv("LR_CONTRACTS_DIR", path.join(REPO_ROOT, "contracts"));
/** 接口草案目录（只读）：两个 MCP 的 tools.json。服务程序由接口侧交付。 */
export const INTERFACES_DIR = dirFromEnv("LR_INTERFACES_DIR", path.join(REPO_ROOT, "interfaces"));
/** 制作 example 目录（只读）：一份无答案上传资料。 */
export const EXAMPLE_DIR = dirFromEnv("LR_EXAMPLE_DIR", path.join(REPO_ROOT, "examples", "input"));

/** 运行期目录：上传解包、审计、报告都在这里，可随时删除重建。 */
export const RUNTIME_DIR = dirFromEnv("LR_RUNTIME_DIR", path.join(APP_ROOT, "runtime"));
export const CASES_DIR = path.join(RUNTIME_DIR, "cases");
export const AUDIT_DIR = path.join(RUNTIME_DIR, "audit");
export const REPORTS_DIR = path.join(RUNTIME_DIR, "reports");

/** 接口连接配置（可编辑）。 */
export const CONFIG_DIR = path.join(APP_ROOT, "config");
export const INTERFACES_CONFIG_PATH = process.env.LR_INTERFACES_CONFIG
  ? path.resolve(process.env.LR_INTERFACES_CONFIG)
  : path.join(CONFIG_DIR, "interfaces.json");

/** 嵌入式 Agent 的数据根：必须在项目内，绝不指向用户全局 ~/.penguin。 */
export const DATA_ROOT = dirFromEnv("LR_DATA_ROOT", path.join(APP_ROOT, "penguin_data"));
export const AGENT_STATE_DIR = path.join(
  DATA_ROOT,
  "default_project",
  "agents",
  "default_agent",
  "agent_state",
);
export const PERSONA_PATH = path.join(APP_ROOT, "agent", "persona.md");
export const AGENT_SKILLS_SRC = path.join(APP_ROOT, "agent", "skills");

export const HOST = process.env.HOST ?? "127.0.0.1";
export const DEFAULT_PORT = Number(process.env.PORT ?? 4711);

/**
 * 本地凭据文件 app/.env（已被 .gitignore 忽略，不会进版本库）。
 * 在这里写模型 API Key（例如 DEEPSEEK_API_KEY=...）；这里只是把文件里的变量放进进程环境，
 * 应用不读取、不打印、不保存任何密钥内容。文件不存在时什么都不做。
 * 已经在 shell 里导出的变量优先，文件不会覆盖它们。
 */
export const ENV_FILE = path.join(APP_ROOT, ".env");

export function loadEnvFile(): { path: string; loaded: boolean; error: string | null } {
  if (!fs.existsSync(ENV_FILE)) return { path: ENV_FILE, loaded: false, error: null };
  try {
    process.loadEnvFile(ENV_FILE);
    return { path: ENV_FILE, loaded: true, error: null };
  } catch (error) {
    return { path: ENV_FILE, loaded: false, error: (error as Error).message };
  }
}

const envFile = loadEnvFile();
if (envFile.error) process.stderr.write(`app/.env 解析失败（已忽略）：${envFile.error}\n`);

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 取一个可用端口：默认端口被占用时顺序向后找（不抢占任何已在运行的服务）。 */
export async function pickPort(preferred: number, span = 12): Promise<number> {
  const net = await import("node:net");
  const free = (port: number) =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, HOST);
    });
  for (let port = preferred; port < preferred + span; port += 1) {
    if (await free(port)) return port;
  }
  throw new Error(`端口 ${preferred} 起连续 ${span} 个端口都被占用，请用 PORT=npm start 指定空闲端口`);
}
