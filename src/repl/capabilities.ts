/** Capabilities injected into the REPL, driven by policy.capabilities and policy.mcp. See docs/design.md §3.2–3.3 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Effect } from '../core/env/backend.js'
import { proxiedFetch } from '../core/env/proxied-fetch.js'
import { McpClient, type McpServerConfig } from '../core/mcp/client.js'
import { declareServer } from '../core/mcp/declare.js'
import type { Policy } from '../core/policy/schema.js'

export interface Capabilities {
  globals: Record<string, unknown>
  /** TypeScript-style declarations of the injected API, shown to the model. */
  declarations: string
  /** The same functions as one MCP tool each, for `envgit mcp --tools`. */
  tools: DirectTool[]
  /** Stops the MCP servers. */
  close(): void
}

/** One injected function as a tool: `<path[0]>[path[1]](...args)`, args from the input by `params` (or the input itself). */
export interface DirectTool {
  name: string
  description?: string
  inputSchema: unknown
  path: [string, string]
  params: string[] | 'input'
}

type Caps = NonNullable<Policy['capabilities']>

const FS_TOOLS: DirectTool[] = [
  { name: 'readFile', description: 'Read a UTF-8 text file.', path: ['fs', 'readFile'], params: ['path'], inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  {
    name: 'writeFile',
    description: 'Write a UTF-8 text file.',
    path: ['fs', 'writeFile'],
    params: ['path', 'data'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, data: { type: 'string' } }, required: ['path', 'data'] },
  },
  { name: 'readdir', description: "List a directory. Directory names end with '/'.", path: ['fs', 'readdir'], params: ['path'], inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
]

/**
 * Effects are observed here, at the syscall/proxy result the wrapper sees. This is
 * the reliable per-step channel; the macOS violation log drops events.
 *
 * MCP servers are started here, inside the sandbox the worker runs in: what they read, write and
 * request is the sandbox's to allow and the gate's to judge, and lands on the step like the REPL's own.
 */
export async function buildCapabilities(
  caps: Caps,
  workdir: string,
  onEffect: (e: Effect) => void = () => {},
  servers: Record<string, McpServerConfig> = {},
): Promise<Capabilities> {
  const globals: Record<string, unknown> = {}
  const decls = [
    'declare function print(...values: unknown[]): void',
    '/** n items spread across an array, first and last included (or n entries of an object): look at a few, not all. */',
    'declare function sample<T>(x: T[], n?: number): T[]',
    '/** The shape of a value as a TypeScript type; array elements merged, keys missing in some marked optional. */',
    'declare function schema(x: unknown): string',
    '/** Throws AssertionError(message) when cond is falsy: check a result in code instead of printing it. */',
    'declare function assert(cond: unknown, message?: string): asserts cond',
  ]
  const tools: DirectTool[] = []
  const tracedFetch = traceFetch(onEffect)

  if (caps.fs === true) {
    const fsOp = <T>(op: 'read' | 'write', path: string, f: (abs: string) => Promise<T>): Promise<T> => {
      const abs = resolve(workdir, path)
      return f(abs).then(
        r => (onEffect({ kind: 'fs', op, path: abs }), r),
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'EPERM' || e.code === 'EACCES') onEffect({ kind: 'fs', op, path: abs, denied: true })
          throw e
        },
      )
    }
    globals.fs = {
      readFile: (path: string) => fsOp('read', path, abs => readFile(abs, 'utf8')),
      writeFile: (path: string, data: string) => fsOp('write', path, abs => writeFile(abs, data)),
      readdir: (path = '.') => fsOp('read', path, async abs => (await readdir(abs, { withFileTypes: true })).map(d => (d.isDirectory() ? `${d.name}/` : d.name))),
    }
    decls.push(`declare const fs: {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  /** Directory names end with '/'. */
  readdir(path?: string): Promise<string[]>
}`)
    tools.push(...FS_TOOLS)
  }

  if (caps.http === true) {
    globals.fetch = tracedFetch
    globals.Headers = Headers
    globals.Request = Request
    globals.Response = Response
    decls.push('declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>')
  }

  const clients: McpClient[] = []
  const close = () => clients.forEach(c => c.close())
  try {
    for (const [name, config] of Object.entries(servers)) {
      const client = await McpClient.start(name, config, workdir)
      clients.push(client)
      const only = caps[name]
      const listed = (await client.listTools()).filter(t => !Array.isArray(only) || only.includes(t.name))
      globals[name] = Object.fromEntries(listed.map(t => [t.name, (args?: unknown) => client.callTool(t.name, args)]))
      decls.push(declareServer(name, listed))
      const taken = new Set(tools.map(t => t.name))
      for (const t of listed) {
        tools.push({ name: taken.has(t.name) ? `${name}_${t.name}` : t.name, description: t.description, inputSchema: t.inputSchema ?? { type: 'object' }, path: [name, t.name], params: 'input' })
      }
    }
  } catch (e) {
    close()
    throw e
  }

  return { globals, declarations: decls.join('\n'), tools, close }
}

function traceFetch(onEffect: (e: Effect) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const net = { kind: 'net' as const, host: url.hostname, port: Number(url.port) || (url.protocol === 'http:' ? 80 : 443), method, path: url.pathname }
    try {
      // http:// as an ordinary proxied request: fetch would tunnel it, which the gate refuses.
      const res = await proxiedFetch(input, init)
      // A 403 from envgit's gate is already on the step as the gate's own effect; don't record it twice.
      const gated = res.status === 403 && (await res.clone().text().then(t => t.startsWith('envgit: '), () => false))
      if (!gated) onEffect(net)
      return res
    } catch (e) {
      if (proxyRefused(e)) onEffect({ ...net, denied: true })
      throw e
    }
  }
}

// srt's proxy refuses a CONNECT with 403; undici buries that a few causes deep.
function proxyRefused(e: unknown): boolean {
  for (let c = e, i = 0; c instanceof Error && i < 5; c = c.cause, i++) {
    if (/Proxy response \(403\)/.test(c.message)) return true
  }
  return false
}
