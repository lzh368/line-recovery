/**
 * MCP stdio 客户端（JSON-RPC 2.0，按行分隔）。
 *
 * 这是本应用对 interfaces/<接口>/tools.json 契约的真实实现：只要接口侧交付了可运行的
 * stdio 服务并在 config/interfaces.json 里配上 command，它就能 initialize → tools/list → tools/call。
 * 服务不存在时它不会伪造任何响应，只会如实报告"未连接"。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  isError: boolean;
  /** 文本内容拼接结果（MCP content[].text）。 */
  text: string;
  /** 工具返回的结构化内容（structuredContent 或单条 text 的 JSON）。 */
  structured: unknown;
  raw: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private tools: McpTool[] = [];
  private lastError: string | null = null;
  private stderrTail: string[] = [];

  constructor(private readonly options: McpServerOptions) {}

  get connected(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get toolList(): McpTool[] {
    return this.tools;
  }

  get error(): string | null {
    return this.lastError;
  }

  get serverStderr(): string[] {
    return this.stderrTail.slice(-20);
  }

  async connect(): Promise<McpTool[]> {
    if (this.connected) return this.tools;
    this.lastError = null;
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...(this.options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.lastError = `无法启动服务进程：${(error as Error).message}`;
      throw new Error(this.lastError);
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk.trimEnd());
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    child.on("error", (error) => this.failAll(`服务进程错误：${error.message}`));
    child.on("exit", (code, signal) => {
      this.failAll(`服务进程已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`);
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "line-recovery-app", version: "0.1.0" },
    }, timeoutMs);
    this.notify("notifications/initialized", {});
    const result = (await this.request("tools/list", {}, timeoutMs)) as { tools?: McpTool[] };
    this.tools = result?.tools ?? [];
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<McpCallResult> {
    if (!this.connected) throw new Error("MCP 服务未连接");
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const texts = (result?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    const text = texts.join("\n");
    let structured: unknown = result?.structuredContent;
    if (structured === undefined && texts.length === 1) {
      try {
        structured = JSON.parse(texts[0]!);
      } catch {
        structured = undefined;
      }
    }
    return {
      isError: result?.isError === true,
      text,
      structured,
      raw: result,
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAll("客户端已断开");
    if (!child) return;
    return new Promise((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 1500).unref();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 非 JSON 输出（日志等）忽略
    }
    if (typeof message?.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`MCP 错误 ${message.error.code ?? ""}: ${message.error.message ?? "未知错误"}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("MCP 服务未连接"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private failAll(message: string): void {
    this.lastError = message;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
    if (this.child && this.child.exitCode !== null) this.child = null;
  }
}
