import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DreamPlugin, RegisteredTool } from '@dream/kernel';

/**
 * Minimal MCP (Model Context Protocol) stdio client — JSON-RPC 2.0 over
 * newline-delimited stdio. Implements the handshake plus tools/list and
 * tools/call, which is everything Dream needs to bridge an MCP server's
 * tools through the kernel's single tool pipeline.
 *
 * Deliberately small: no resources/prompts/sampling subscribers (Dream's
 * memory plays those roles), no reconnect protocol — a dead server surfaces
 * as tool errors through the pipeline, where policy hooks can see them.
 */

export interface McpServerConfig {
  /** Short name; tools are exposed as `mcp__<name>__<tool>`. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Handshake/tool-call timeout. */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly timeoutMs: number;

  constructor(private readonly config: McpServerConfig) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  async connect(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.config.command),
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.on('exit', (code) => this.failAll(new Error(`MCP server "${this.config.name}" exited (code ${code})`)));
    this.child.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dream', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDefinition[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }

  /** Request-scoped environment hardening happens at spawn; this closes the child. */
  close(): void {
    this.failAll(new Error(`MCP server "${this.config.name}" closed`));
    this.child?.kill();
    this.child = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error(`MCP server "${this.config.name}" is not connected`));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child!.stdin.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // servers occasionally log to stdout; ignore non-JSON lines
      }
      if (message.id === undefined) continue; // notification
      const entry = this.pending.get(Number(message.id));
      if (!entry) continue;
      this.pending.delete(Number(message.id));
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

export interface McpPluginOptions {
  servers: McpServerConfig[];
  /** Log handshake results; default silent. */
  onLog?: (message: string) => void;
}

/**
 * Dream plugin that bridges MCP servers into the tool pipeline. Every exposed
 * tool is registered through `ctx.tools.register`, so MCP calls traverse the
 * SAME single waterfall as built-in tools (pre/post hooks, policy deny, loop
 * detection) — dsh's "no second door" rule holds for MCP exactly as for any
 * other tool.
 */
export class McpToolsPlugin implements DreamPlugin {
  readonly name = 'tools-mcp';
  private readonly clients: McpStdioClient[] = [];

  constructor(private readonly options: McpPluginOptions) {}

  async apply(ctx: Parameters<DreamPlugin['apply']>[0]): Promise<void> {
    for (const server of this.options.servers) {
      const client = new McpStdioClient(server);
      try {
        await client.connect();
        const tools = await client.listTools();
        for (const tool of tools) {
          const qualified = `mcp__${server.name}__${tool.name}`;
          const registered: RegisteredTool = {
            name: qualified,
            description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            handler: async (args) => {
              const result = (await client.callTool(tool.name, args)) as {
                content?: Array<{ type: string; text?: string }>;
                isError?: boolean;
              };
              const text =
                result?.content
                  ?.map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
                  .join('\n') ?? '';
              if (result?.isError) throw new Error(text || 'MCP tool returned an error');
              return text;
            },
          };
          ctx.tools.register(registered);
        }
        this.clients.push(client);
        this.options.onLog?.(`mcp:${server.name} connected — ${tools.length} tool(s)`);
      } catch (err) {
        client.close();
        this.options.onLog?.(`mcp:${server.name} unavailable — ${String(err)}`);
      }
    }
  }

  /** Close every server process (kernel disposal path). */
  close(): void {
    for (const client of this.clients.splice(0)) client.close();
  }
}
