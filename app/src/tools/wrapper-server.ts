/**
 * 受控设备工具的 MCP 服务（stdio，按行分隔的 JSON-RPC 2.0，protocolVersion 2025-06-18）。
 *
 * 它由嵌入式 Agent 的 Session 当普通 MCP 服务启动（见 src/setup-agent.ts 的 tools.mcpServers），
 * 因此模型看到的是真实的 `mcp__recovery-control__<tool>` 工具，调用会真正落到这里 ——
 * 不是"提示模型遵守约定"，而是它想调就必须经过这一层。
 *
 * 两条纪律：
 * - 只读与写工具都只接受空入参（见 agent-tools.ts）：模型说不清设备、版本和请求号，也不允许说。
 * - 服务进程的 cwd 由 Session 决定（= 案例工作目录），案例由它反查；反查不到就报错，不猜。
 *
 * stdout 只允许输出 JSON-RPC（日志一律走 stderr），与 interfaces/shared/stdio.py 一致。
 */
import { AGENT_TOOLS, callAgentTool, isAgentToolName } from "./agent-tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
/** 单行上限与 interfaces/shared/stdio.py 一致：超长行直接拒绝，不试图解析。 */
const MAX_LINE = 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolDefinitions(): Record<string, unknown>[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

function text(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

async function callTool(name: unknown, args: unknown): Promise<{ result: unknown; isError: boolean }> {
  if (typeof name !== "string" || !isAgentToolName(name)) {
    return { result: { error: "TOOL_REJECTED", message: `本服务不提供该工具：${String(name)}` }, isError: true };
  }
  const extra = args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
  if (extra.length) {
    // 设备、版本、请求号由后端补全：模型多传的任何字段都是越界，直接拒绝，不做"忽略后继续"。
    return {
      result: {
        error: "TOOL_REJECTED",
        message: `该工具不接受任何入参（收到 ${extra.join(", ")}）：设备、版本与请求号由后端补全。`,
      },
      isError: true,
    };
  }
  const call = await callAgentTool(name, process.cwd());
  return { result: call.payload, isError: !call.ok };
}

async function main(): Promise<void> {
  const definitions = toolDefinitions();
  let initialized = false;
  let ready = false;
  let buffer = "";

  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    if (buffer.length > MAX_LINE && buffer.indexOf("\n") < 0) {
      sendError(null, -32700, "message exceeds limit");
      break;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      await handleLine(line);
    }
  }

  async function handleLine(line: string): Promise<void> {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      sendError(null, -32700, "invalid JSON");
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      sendError(null, -32600, "invalid JSON-RPC request");
      return;
    }
    const { method } = message;
    const id = message.id ?? null;
    const params = message.params ?? {};

    // 通知（没有 id）永远不产生写动作：未确认的通知被忽略。
    if (!("id" in message)) {
      if (method === "notifications/initialized" && initialized) ready = true;
      return;
    }
    if ((typeof id !== "number" && typeof id !== "string") || !params || typeof params !== "object") {
      sendError(null, -32600, "invalid id or params");
      return;
    }

    try {
      if (method === "initialize") {
        if (initialized || typeof params.protocolVersion !== "string") {
          sendError(id, -32602, "invalid initialization");
          return;
        }
        initialized = true;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "line-recovery-recovery-control", version: "0.1.0" },
            instructions:
              "受控恢复工具。查询只读；写工具由后端补齐版本与请求号并在执行点前重新核对，受理不等于执行完成。",
          },
        });
        return;
      }
      if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (!ready) {
        sendError(id, -32002, "initialization required");
        return;
      }
      if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: definitions } });
        return;
      }
      if (method === "tools/call") {
        const { result, isError } = await callTool(params.name, params.arguments ?? {});
        send({
          jsonrpc: "2.0",
          id,
          result: { content: text(result), structuredContent: result, isError },
        });
        return;
      }
      sendError(id, -32601, "method not found");
    } catch (error) {
      // 服务本身出错也要如实回答，但不把进程带走：stdout 里不放堆栈，stderr 留给部署方排查。
      process.stderr.write(`recovery-control: ${(error as Error).message}\n`);
      sendError(id, -32603, "internal error");
    }
  }
}

await main();
