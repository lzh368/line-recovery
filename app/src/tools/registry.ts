/**
 * 接口注册表：把 interfaces/<id>/tools.json 的契约、config/interfaces.json 的连接配置
 * 和实际连接状态合成一份前端可读的工具状态。
 *
 * 默认配置指向仓库内两个 Python stdio 演示服务；未初始化或连接失败时如实显示不可用。
 * 应用不会因为缺少服务而编造状态或动作结果。
 */
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, INTERFACES_CONFIG_PATH, INTERFACES_DIR } from "../paths.ts";
import { McpStdioClient, type McpTool } from "./mcp.ts";

export type InterfaceId = "power-control" | "cooling-control";

export interface InterfaceDefinition {
  id: InterfaceId;
  title: string;
  /** 查询工具：读当前可信状态，不改变设备。 */
  statusTool: string;
  /** 写工具：请求执行受控动作。 */
  writeTool: string;
  /** 写工具对应的动作名（action-result.schema.json 的 action）。 */
  action: "resume_conveyor" | "start_cooling";
  readmePath: string;
  toolsPath: string;
}

export const INTERFACES: Record<InterfaceId, InterfaceDefinition> = {
  "power-control": {
    id: "power-control",
    title: "供电恢复 power-control",
    statusTool: "get_device_status",
    writeTool: "resume_conveyor",
    action: "resume_conveyor",
    readmePath: path.join(INTERFACES_DIR, "power-control", "README.md"),
    toolsPath: path.join(INTERFACES_DIR, "power-control", "tools.json"),
  },
  "cooling-control": {
    id: "cooling-control",
    title: "散热控制 cooling-control",
    statusTool: "get_cooling_status",
    writeTool: "start_cooling",
    action: "start_cooling",
    readmePath: path.join(INTERFACES_DIR, "cooling-control", "README.md"),
    toolsPath: path.join(INTERFACES_DIR, "cooling-control", "tools.json"),
  },
};

/**
 * `idle` 与 `error` 必须分开：配了服务但这一次还没试过连接，不是"连接失败"，
 * 只有真正试过并失败才是。前端据此如实显示，不把"没试过"写成"失败"。
 */
export type ConnectionState = "not_configured" | "idle" | "connecting" | "connected" | "error";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  not_configured: "工具未连接",
  idle: "未连接（尚未尝试）",
  connecting: "连接中",
  connected: "已连接",
  error: "连接失败",
};

interface InterfaceConfig {
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  timeout_ms?: number;
  note?: string;
}

interface AppInterfaceConfig {
  execution_mode?: "dry_run" | "live";
  interfaces?: Partial<Record<InterfaceId, InterfaceConfig>>;
}

interface RuntimeState {
  client: McpStdioClient | null;
  state: ConnectionState;
  error: string | null;
  connectedAt: string | null;
  tools: McpTool[];
}

const runtime: Record<InterfaceId, RuntimeState> = {
  "power-control": { client: null, state: "idle", error: null, connectedAt: null, tools: [] },
  "cooling-control": { client: null, state: "idle", error: null, connectedAt: null, tools: [] },
};

export function loadConfig(): AppInterfaceConfig {
  if (!fs.existsSync(INTERFACES_CONFIG_PATH)) return { execution_mode: "dry_run", interfaces: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(INTERFACES_CONFIG_PATH, "utf8")) as AppInterfaceConfig;
    return parsed ?? { execution_mode: "dry_run", interfaces: {} };
  } catch {
    return { execution_mode: "dry_run", interfaces: {} };
  }
}

/** 执行模式只能来自部署方配置；上传包和 Agent 参数都不能切换（见 interfaces/<接口>/README.md）。 */
export function executionMode(): "dry_run" | "live" {
  return loadConfig().execution_mode === "live" ? "live" : "dry_run";
}

function declaredTools(def: InterfaceDefinition): McpTool[] {
  try {
    const raw = JSON.parse(fs.readFileSync(def.toolsPath, "utf8")) as { tools?: McpTool[] };
    return raw.tools ?? [];
  } catch {
    return [];
  }
}

export interface InterfaceStatus {
  id: InterfaceId;
  title: string;
  action: string;
  statusTool: string;
  writeTool: string;
  connection: ConnectionState;
  /** 前端主状态文案。 */
  connectionLabel: string;
  serviceConfigured: boolean;
  serviceCommand: string | null;
  serviceExists: boolean;
  error: string | null;
  connectedAt: string | null;
  tools: { name: string; description: string }[];
  declaredTools: { name: string; description: string }[];
  executionMode: "dry_run" | "live";
  note: string | null;
  toolsJsonPath: string;
}

function commandExists(command: string, cwd?: string | null): boolean {
  if (command.startsWith(".") || command.startsWith("/")) {
    const resolved = path.resolve(cwd ?? process.cwd(), command);
    return fs.existsSync(resolved);
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return dirs.some((dir) => dir && fs.existsSync(path.join(dir, command)));
}

/** 配置里没有 command 就一定"未连接"；配了 command 时如实反映连接尝试的结果。 */
function connectionOf(state: RuntimeState, command: string | null): ConnectionState {
  if (!command) return "not_configured";
  return state.state === "not_configured" ? "idle" : state.state;
}

export function statusList(): InterfaceStatus[] {
  const config = loadConfig();
  const mode = executionMode();
  return Object.values(INTERFACES).map((def) => {
    const cfg = config.interfaces?.[def.id] ?? {};
    const state = runtime[def.id];
    const command = cfg.command?.trim() ? cfg.command.trim() : null;
    const tools = state.tools.length ? state.tools : declaredTools(def);
    const connection = connectionOf(state, command);
    return {
      id: def.id,
      title: def.title,
      action: def.action,
      statusTool: def.statusTool,
      writeTool: def.writeTool,
      connection,
      connectionLabel: CONNECTION_LABEL[connection],
      serviceConfigured: Boolean(command),
      serviceCommand: command,
      serviceExists: command ? commandExists(command, path.resolve(APP_ROOT, cfg.cwd ?? ".")) : false,
      error: state.error,
      connectedAt: state.connectedAt,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
      declaredTools: declaredTools(def).map((t) => ({ name: t.name, description: t.description ?? "" })),
      executionMode: mode,
      note: cfg.note ?? null,
      toolsJsonPath: path.relative(process.cwd(), def.toolsPath),
    };
  });
}

export function getClient(id: InterfaceId): McpStdioClient | null {
  return runtime[id].client;
}

export function isConnected(id: InterfaceId): boolean {
  return runtime[id].state === "connected" && runtime[id].client?.connected === true;
}

export async function connect(id: InterfaceId): Promise<InterfaceStatus> {
  const def = INTERFACES[id];
  const cfg = loadConfig().interfaces?.[id] ?? {};
  const command = cfg.command?.trim();
  if (!command) {
    runtime[id] = { ...runtime[id], state: "not_configured", error: "未配置服务命令（config/interfaces.json 的 command 为空）", tools: [] };
    return statusList().find((s) => s.id === id)!;
  }
  if (runtime[id].client) await runtime[id].client.close();
  const client = new McpStdioClient({
    command,
    args: cfg.args ?? [],
    env: { ...(cfg.env ?? {}), LINE_RECOVERY_MODE: executionMode() },
    cwd: path.resolve(APP_ROOT, cfg.cwd ?? "."),
    timeoutMs: cfg.timeout_ms ?? 10_000,
  });
  runtime[id] = { client, state: "connecting", error: null, connectedAt: null, tools: [] };
  try {
    const tools = await client.connect();
    runtime[id] = {
      client,
      state: "connected",
      error: null,
      connectedAt: new Date().toISOString(),
      tools,
    };
  } catch (error) {
    await client.close().catch(() => {});
    runtime[id] = {
      client: null,
      state: "error",
      error: (error as Error).message,
      connectedAt: null,
      tools: [],
    };
  }
  void def;
  return statusList().find((s) => s.id === id)!;
}

export async function disconnect(id: InterfaceId): Promise<InterfaceStatus> {
  const client = runtime[id].client;
  if (client) await client.close().catch(() => {});
  // 主动断开是明确的"未连接"，不是失败：下一次连接会重新尝试。
  runtime[id] = { client: null, state: "idle", error: null, connectedAt: null, tools: [] };
  return statusList().find((s) => s.id === id)!;
}

/**
 * 要用工具时才连接：已连接就直接用；没配置服务就如实返回 false（不编造可用）；
 * 配置了就试这一次，结果留在 runtime 里（失败会如实显示成"连接失败"，而不是一直"未尝试"）。
 *
 * Agent 的受控工具服务是独立进程，它必须自己连接设备接口 —— 不能指望页面按钮先连过。
 */
export async function ensureConnected(id: InterfaceId): Promise<boolean> {
  if (isConnected(id)) return true;
  if (!(loadConfig().interfaces?.[id]?.command ?? "").trim()) return false;
  await connect(id);
  return isConnected(id);
}

/** 调用接口工具；未连接时抛错，绝不返回编造结果。 */
export async function callTool(id: InterfaceId, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const client = runtime[id].client;
  if (!client || runtime[id].state !== "connected") {
    throw new Error(`工具未连接：${INTERFACES[id].title} 未配置可运行的服务进程`);
  }
  const result = await client.callTool(tool, args);
  if (result.isError) throw new Error(`工具 ${tool} 返回错误：${result.text || "无附加说明"}`);
  return result.structured ?? result.text;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all(Object.keys(runtime).map((id) => disconnect(id as InterfaceId)));
}
