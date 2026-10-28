/**
 * A minimal MCP client over stdio, for the REPL worker (docs/design.md §3.3). The worker and the
 * servers it starts both run inside the sandbox, so a server's own requests go through the proxy and
 * the gate. Dependency-free on purpose: the vm backend installs the worker as a handful of files.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
}

interface CallResult {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

const PROTOCOL_VERSION = '2025-06-18'
const START_TIMEOUT_MS = 30_000
const STDERR_TAIL = 4096

export class McpClient {
  private next = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private stderr = ''
  private exited?: string

  private constructor(
    readonly name: string,
    private readonly child: ChildProcess,
  ) {
    child.stderr!.on('data', (b: Buffer) => (this.stderr = (this.stderr + b.toString()).slice(-STDERR_TAIL)))
    child.on('error', e => this.fail(e.message))
    child.on('exit', (code, sig) => this.fail(`exited (${sig ?? code})`))
    createInterface({ input: child.stdout! }).on('line', line => this.receive(line))
  }

  static async start(name: string, config: McpServerConfig, cwd: string): Promise<McpClient> {
    // Not envgit's own variables: the server list holds every server's tokens.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ENVGIT_')))
    const child = spawn(config.command, config.args ?? [], { cwd, env: { ...env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const client = new McpClient(name, child)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'envgit', version: '0.0.1' } }),
        new Promise((_, reject) => (timer = setTimeout(() => reject(client.error(`no answer to initialize in ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS))),
      ])
    } catch (e) {
      client.close()
      throw e
    } finally {
      clearTimeout(timer)
    }
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return client
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools: McpTool[]; nextCursor?: string }
      tools.push(...r.tools)
      cursor = r.nextCursor
    } while (cursor)
    return tools
  }

  /** The tool's result as a value: its structured content, else its text (parsed when it is JSON). */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const r = (await this.request('tools/call', { name, arguments: args ?? {} })) as CallResult
    const texts = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '')
    if (r.isError) throw new Error(`${this.name}.${name}: ${texts.join('\n') || 'failed'}`)
    if (r.structuredContent !== undefined) return r.structuredContent
    if (texts.length === 1 && texts.length === r.content!.length) return parseJson(texts[0]!)
    return r.content
  }

  close(): void {
    this.child.stdin?.end()
    this.child.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(this.error(this.exited))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private send(msg: unknown) {
    this.child.stdin!.write(JSON.stringify(msg) + '\n')
  }

  private receive(line: string) {
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method !== undefined) {
      // A request from the server: answer ping; this client offers nothing else (no roots, sampling, elicitation).
      if (msg.id !== undefined) {
        this.send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } })
      }
      return
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id as number)
    if (msg.error) p.reject(new Error(`MCP server ${this.name}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }

  private fail(reason: string) {
    this.exited ??= reason
    for (const p of this.pending.values()) p.reject(this.error(reason))
    this.pending.clear()
  }

  private error(reason: string): Error {
    const tail = this.stderr.trim().split('\n').slice(-10).join('\n')
    return new Error(`MCP server ${this.name}: ${reason}${tail ? `\n${tail}` : ''}`)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
