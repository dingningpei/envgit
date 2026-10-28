/** Sandboxed REPL worker: newline-delimited JSON over stdin/stdout. Runs under srt. */
import { createInterface } from 'node:readline'
import type { Effect } from '../core/env/backend.js'
import type { McpServerConfig } from '../core/mcp/client.js'
import type { Policy } from '../core/policy/schema.js'
import { buildCapabilities, type Capabilities, type DirectTool } from './capabilities.js'
import { VmEngine } from './engine.js'

export interface WorkerRequest {
  id: number
  code: string
}

export type WorkerMessage = { ready: true } | { id: number; output: string; error?: string; effects: Effect[] }

/** What `DESCRIBE` answers, as the reply's output (JSON). */
export interface Description {
  declarations: string
  tools: DirectTool[]
}

export const CAPABILITIES_ENV = 'ENVGIT_CAPABILITIES'
/** The MCP servers to start, `${VAR}`s already filled in by envgit outside (`mcpServers`). */
export const MCP_ENV = 'ENVGIT_MCP'
/**
 * A request for the injected API instead of code to run. A code string, so that it travels the vm
 * backend's REPL channel unchanged; not valid JavaScript, so no cell can be mistaken for it.
 */
export const DESCRIBE = '\0envgit:describe'
/** Prefix for a cell whose output comes back whole, not as a handle or cut: a tool result for `envgit mcp --tools`. */
export const RAW = '\0envgit:raw\n'

export async function runWorker(): Promise<void> {
  const caps = JSON.parse(process.env[CAPABILITIES_ENV] ?? '{}') as NonNullable<Policy['capabilities']>
  const servers = JSON.parse(process.env[MCP_ENV] ?? '{}') as Record<string, McpServerConfig>
  let effects: Effect[] = []
  const send = (m: WorkerMessage) => process.stdout.write(JSON.stringify(m) + '\n')
  // A server that will not start is reported on every request rather than taking the worker down.
  let built: Capabilities | undefined
  let startError: string | undefined
  try {
    built = await buildCapabilities(caps, process.cwd(), e => effects.push(e), servers)
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e)
  }
  process.once('exit', () => built?.close())
  process.once('SIGTERM', () => process.exit(143))
  const engine = built && new VmEngine(built.globals)
  send({ ready: true })
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    const req = JSON.parse(line) as WorkerRequest
    effects = []
    if (!built || !engine) {
      send({ id: req.id, output: '', error: startError!, effects })
    } else if (req.code === DESCRIBE) {
      send({ id: req.id, output: JSON.stringify({ declarations: built.declarations, tools: built.tools } satisfies Description), effects })
    } else {
      const raw = req.code.startsWith(RAW)
      const result = await engine.execute(raw ? req.code.slice(RAW.length) : req.code, { raw })
      send({ id: req.id, ...result, effects })
    }
  }
  built?.close()
}
