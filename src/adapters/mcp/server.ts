/** Exposes the REPL as an MCP server over stdio. See docs/design.md §3.4 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DirectTool } from '../../repl/capabilities.js'
import type { Repl } from '../../repl/session.js'
import { RAW } from '../../repl/worker.js'
import { HANDLE_LIMIT, OUTPUT_LIMIT } from '../../repl/engine.js'
import type { Effect } from '../../core/env/backend.js'
import type { Approver, Gate } from '../../core/policy/gate.js'

export type McpMode = 'repl' | 'tools'

export async function serveMcp(repl: Repl, mode: McpMode = 'repl', gate?: Gate): Promise<void> {
  // The API comes from the worker itself, inside the sandbox, where the MCP servers run.
  const { declarations, tools } = await repl.describe()
  const server = new McpServer(
    { name: 'envgit', version: '0.0.1' },
    mode === 'repl'
      ? {
          instructions:
            'envgit runs JavaScript in a persistent, sandboxed REPL. Prefer one `execute` call that does the whole job over many small tool calls; only what you print() or return comes back. Keep data in the sandbox: compute on it, check it with assert(), look at it with sample() and schema(), and print only the answer.',
        }
      : {},
  )
  if (mode === 'tools') registerDirectTools(server, repl, tools)
  else registerExecute(server, repl, declarations)
  const closed = new Promise<void>(resolve => {
    server.server.onclose = resolve
    // The client going away closes stdin; with no worker process of ours keeping the loop alive (vm
    // backend), that is the only signal we get.
    process.stdin.once('end', resolve).once('close', resolve)
  })
  if (gate) askThroughClient(server, gate)
  await server.connect(new StdioServerTransport())
  await closed
}

function registerExecute(server: McpServer, repl: Repl, declarations: string) {
  server.registerTool(
    'execute',
    {
      description: `Run JavaScript in a persistent sandboxed REPL. Top-level await works; top-level variables survive between calls. Only print() output and the value of the last expression are returned. A returned value longer than ${HANDLE_LIMIT} characters printed stays in the sandbox as $1, $2, … and you get its type; output beyond ${OUTPUT_LIMIT} characters is cut in the middle. No require/import/process. Available API:\n\n${declarations}`,
      inputSchema: { code: z.string().describe('JavaScript source to run') },
    },
    async ({ code }) => {
      const r = await repl.execute(code)
      const denied = r.effects.flatMap(describeDenial)
      const text = [r.output, r.error, denied.length && `[sandbox denied]\n${denied.join('\n')}`].filter(Boolean).join('\n') || '(no output)'
      return { content: [{ type: 'text', text }], isError: Boolean(r.error) }
    },
  )
}

/** Once the client has said what it supports: if it can elicit, `ask` rules ask its user. */
export function askThroughClient(server: McpServer, gate: Gate): void {
  server.server.oninitialized = () => {
    if (server.server.getClientCapabilities()?.elicitation) gate.setApprover(elicitApprover(server), 'the MCP client')
  }
}

/** Asks the person behind the MCP client (e.g. Claude Code's dialog); decline, cancel or no answer denies. */
function elicitApprover(server: McpServer): Approver {
  return async ({ action, rule }) => {
    const r = await server.server.elicitInput(
      {
        mode: 'form',
        message: `envgit: the sandbox wants to do something irreversible:\n\n  ${action}\n\nrule: ${rule}. Allow it?`,
        requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: 'Allow this action', default: false } }, required: ['allow'] },
      },
      { timeout: 5 * 60_000 },
    )
    return r.action === 'accept' && r.content?.allow === true
  }
}

function describeDenial(e: Effect): string[] {
  switch (e.kind) {
    case 'fs':
      return e.denied ? [`fs ${e.op} ${e.path}`] : []
    case 'net':
      if (!e.denied) return []
      return [`net ${e.method ?? ''} ${e.host}${e.path ?? `:${e.port}`}${e.irreversible ? ` — irreversible (${e.irreversible.rule}), not approved` : ''}`.replace('  ', ' ')]
    case 'policy':
      return /\b(file|network)-\S+\s+\S/.test(e.reason) ? [e.reason] : []
    default:
      return []
  }
}

/**
 * One MCP tool per injected function, the way agents usually get tools today, with the schema it came
 * with. Each call still runs through the sandboxed REPL, so isolation and the step log match `execute`.
 */
function registerDirectTools(server: McpServer, repl: Repl, tools: DirectTool[]) {
  // Raw JSON Schemas pass through as they are, so this bypasses registerTool (which wants zod).
  server.server.registerCapabilities({ tools: {} })
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' } })),
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async req => {
    const t = tools.find(x => x.name === req.params.name)
    if (!t) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true }
    const input = req.params.arguments ?? {}
    const args = t.params === 'input' ? [input] : t.params.map(p => input[p]).filter(v => v !== undefined)
    const code = `${RAW}const r = await ${t.path[0]}[${JSON.stringify(t.path[1])}](...${JSON.stringify(args)}); typeof r === 'string' ? r : JSON.stringify(r, null, 1)`
    const r = await repl.execute(code)
    return { content: [{ type: 'text', text: r.error ?? r.output.replace(/\n$/, '') }], isError: Boolean(r.error) }
  })
}
