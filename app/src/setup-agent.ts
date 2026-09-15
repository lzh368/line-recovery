/**
 * npm run setup：初始化应用自带的嵌入式 Agent State。
 *
 * 1. 在 app/penguin_data 下创建/加载 default_agent（createAgent 首次运行会初始化目录结构）
 * 2. 把 agent/persona.md 写进它的 AGENTS.md（人格的唯一来源在仓库里，便于复查）
 * 3. 写入 name / description / version 与 model.thinking_level
 * 4. 只保留读取案例所需的 read_file 工具 + 一个受控设备工具 MCP 服务，关闭 memory / schedules 注入
 * 5. 只安装本项目需要的一个 Skill，移除初始化时带出的库技能
 */
import fs from "node:fs";
import path from "node:path";
import { createAgent } from "@prismshadow/penguin-core";
import YAML from "yaml";
import { AGENT_SKILLS_SRC, AGENT_STATE_DIR, APP_ROOT, DATA_ROOT, PERSONA_PATH } from "./paths.ts";
import { MCP_SERVER_NAME } from "./tools/agent-tools.ts";

/** Builder（本会话）system_config.yaml 里的 thinking_level，作为新 Agent 的取值。 */
const BUILDER_THINKING_LEVEL = "xhigh";

const NAME = "产线恢复助手（嵌入式 Agent）";
const DESCRIPTION = "读取纸箱输送工位上传资料，核对停机经过与恢复条件，输出历史异常判断、证据与恢复计划。";

/** tsx CLI 从 app/node_modules 解析，路径按本文件位置推导，整个 app/ 可以整体搬走。 */
const TSX_CLI = path.join(APP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WRAPPER_SERVER = path.join(APP_ROOT, "src", "tools", "wrapper-server.ts");
/**
 * 服务进程的 env 只拿到 SDK 的安全白名单，应用自己的 LR_* 一个都不会自动带过去；
 * 这里显式把"确实设置过"的那几个传下去，让包装服务与本应用解析到同一套目录与配置。
 * 没设置就留空：两边都用同一份默认值。
 */
const RELAYED_ENV_KEYS = ["LR_RUNTIME_DIR", "LR_CONTRACTS_DIR", "LR_INTERFACES_DIR", "LR_INTERFACES_CONFIG", "LR_DATA_ROOT", "LR_EXAMPLE_DIR"];

function relayedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RELAYED_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim()) env[key] = value;
  }
  return env;
}

async function main(): Promise<void> {
  if (!fs.existsSync(PERSONA_PATH)) throw new Error(`缺少人格文件：${PERSONA_PATH}`);
  const persona = fs.readFileSync(PERSONA_PATH, "utf8").trim();
  if (!persona) throw new Error("persona.md 为空");
  if (!fs.existsSync(TSX_CLI)) throw new Error(`找不到 tsx CLI：${TSX_CLI}（先 npm install）`);
  if (!fs.existsSync(WRAPPER_SERVER)) throw new Error(`找不到受控工具服务：${WRAPPER_SERVER}`);

  await createAgent({ root: DATA_ROOT }); // 首次调用即初始化 agent_state 目录

  const configPath = path.join(AGENT_STATE_DIR, "system_config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;

  const readFileEntry = (config.tools?.builtin ?? []).find((t: any) => t?.name === "read_file");
  if (!readFileEntry) throw new Error("默认配置里找不到 read_file 工具定义，无法裁剪工具集");

  config.name = NAME;
  config.description = DESCRIPTION;
  config.version = 1;
  config.model = { ...(config.model ?? {}), thinking_level: BUILDER_THINKING_LEVEL };
  config.tools = {
    builtin: [readFileEntry],
    mcpServers: [
      {
        name: MCP_SERVER_NAME,
        config: {
          command: process.execPath,
          args: [TSX_CLI, WRAPPER_SERVER],
          env: relayedEnv(),
          // 写工具含最长 30 s 的限时状态读回；连接超时留出余量，避免把正常的读回等成失败。
          timeoutMs: 90_000,
          connectTimeoutMs: 20_000,
          note: "本应用自带的受控设备工具（src/tools/wrapper-server.ts）；cwd 由会话决定，即案例工作目录。",
        },
      },
    ],
  };
  config.memory = { ...(config.memory ?? {}), enabled: false };
  config.schedules = { ...(config.schedules ?? {}), enabled: false };

  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  fs.writeFileSync(path.join(AGENT_STATE_DIR, "AGENTS.md"), `${persona}\n`, "utf8");

  // 只保留本项目 Skill：初始化会带出整库技能，它们的描述会进入每次请求的系统提示。
  const skillsDir = path.join(AGENT_STATE_DIR, "skills");
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const entry of fs.readdirSync(AGENT_SKILLS_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    fs.cpSync(path.join(AGENT_SKILLS_SRC, entry.name), path.join(skillsDir, entry.name), { recursive: true });
  }

  const check = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
  const skills = fs.readdirSync(skillsDir);
  const agentsMd = fs.readFileSync(path.join(AGENT_STATE_DIR, "AGENTS.md"), "utf8");

  process.stdout.write(`Agent State： ${AGENT_STATE_DIR}\n`);
  process.stdout.write(`  name=${check.name}\n  description=${check.description}\n  version=${check.version}\n`);
  process.stdout.write(`  model.thinking_level=${check.model?.thinking_level}\n`);
  process.stdout.write(`  tools.builtin=${(check.tools?.builtin ?? []).map((t: any) => t.name).join(",")}\n`);
  const servers = (check.tools?.mcpServers ?? []) as any[];
  process.stdout.write(
    `  tools.mcpServers=${servers.map((s) => s?.name).join(",") || "（无）"}${
      servers.length ? `（${servers[0]?.config?.command} ${(servers[0]?.config?.args ?? []).join(" ")}）` : ""
    }\n`,
  );
  process.stdout.write(`  skills=${skills.join(",")}\n`);
  process.stdout.write(`  AGENTS.md=${agentsMd.length} 字节\n`);
  process.stdout.write("完成。\n");
}

await main();
