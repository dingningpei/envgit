/** Exposes the REPL as an MCP server over stdio. See docs/design.md §3.4 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildCapabilities } from '../../repl/capabilities.js'
import type { ReplSession } from '../../repl/session.js'
import type { Effect } from '../../core/env/backend.js'
import type { Policy } from '../../core/policy/schema.js'

export type McpMode = 'repl' | 'tools'

export async function serveMcp(repl: ReplSession, policy: Policy, workdir: string, mode: McpMode = 'repl'): Promise<void> {
  const { declarations, globals } = buildCapabilities(policy.capabilities ?? {}, workdir)
  const server = new McpServer(
    { name: 'envgit', version: '0.0.1' },
    mode === 'repl'
      ? {
          instructions:
            'envgit runs JavaScript in a persistent, sandboxed REPL. Prefer one `execute` call that does the whole job over many small tool calls; only what you print() or return comes back.',
        }
      : {},
  )
  if (mode === 'tools') registerDirectTools(server, repl, globals)
  else registerExecute(server, repl, declarations)
  const closed = new Promise<void>(resolve => (server.server.onclose = resolve))
  await server.connect(new StdioServerTransport())
  await closed
}

function registerExecute(server: McpServer, repl: ReplSession, declarations: string) {
  server.registerTool(
    'execute',
    {
      description: `Run JavaScript in a persistent sandboxed REPL. Top-level await works; top-level variables survive between calls. Only print() output and the value of the last expression are returned. No require/import/process. Available API:\n\n${declarations}`,
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

function describeDenial(e: Effect): string[] {
  switch (e.kind) {
    case 'fs':
      return e.denied ? [`fs ${e.op} ${e.path}`] : []
    case 'net':
      return e.denied ? [`net ${e.method ?? ''} ${e.host}:${e.port}`.replace('  ', ' ')] : []
    case 'policy':
      return /\b(file|network)-\S+\s+\S/.test(e.reason) ? [e.reason] : []
    default:
      return []
  }
}

/**
 * One MCP tool per capability function, the way agents usually get tools today. Each call
 * still runs through the sandboxed REPL, so isolation and the step log match `execute`.
 */
const DIRECT_TOOLS: Record<string, { fn: string; description: string; params: string[]; schema: Record<string, z.ZodType> }> = {
  readFile: { fn: 'fs.readFile', description: 'Read a UTF-8 text file.', params: ['path'], schema: { path: z.string() } },
  writeFile: { fn: 'fs.writeFile', description: 'Write a UTF-8 text file.', params: ['path', 'data'], schema: { path: z.string(), data: z.string() } },
  readdir: { fn: 'fs.readdir', description: "List a directory. Directory names end with '/'.", params: ['path'], schema: { path: z.string().optional() } },
  listIssues: {
    fn: 'github.listIssues',
    description: 'List issues of a GitHub repository.',
    params: ['args'],
    schema: { owner: z.string(), repo: z.string(), state: z.enum(['open', 'closed', 'all']).optional(), per_page: z.number().optional() },
  },
  getIssue: { fn: 'github.getIssue', description: 'Get one GitHub issue.', params: ['args'], schema: { owner: z.string(), repo: z.string(), number: z.number() } },
}

function registerDirectTools(server: McpServer, repl: ReplSession, globals: Record<string, unknown>) {
  for (const [name, t] of Object.entries(DIRECT_TOOLS)) {
    const [ns, fn] = t.fn.split('.') as [string, string]
    if (typeof (globals[ns] as Record<string, unknown> | undefined)?.[fn] !== 'function') continue
    server.registerTool(name, { description: t.description, inputSchema: t.schema }, async (input: Record<string, unknown>) => {
      const args = t.params[0] === 'args' ? [input] : t.params.map(p => input[p]).filter(v => v !== undefined)
      const code = `const r = await ${t.fn}(...${JSON.stringify(args)}); typeof r === 'string' ? r : JSON.stringify(r, null, 1)`
      const r = await repl.execute(code)
      return { content: [{ type: 'text', text: r.error ?? r.output.replace(/\n$/, '') }], isError: Boolean(r.error) }
    })
  }
}
