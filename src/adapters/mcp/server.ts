/** Exposes the REPL as an MCP server over stdio. See docs/design.md §3.4 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildCapabilities } from '../../repl/capabilities.js'
import type { ReplSession } from '../../repl/session.js'
import type { Effect } from '../../core/env/backend.js'
import type { Policy } from '../../core/policy/schema.js'

export async function serveMcp(repl: ReplSession, policy: Policy, workdir: string): Promise<void> {
  const { declarations } = buildCapabilities(policy.capabilities ?? {}, workdir)
  const server = new McpServer(
    { name: 'envgit', version: '0.0.1' },
    {
      instructions:
        'envgit runs JavaScript in a persistent, sandboxed REPL. Prefer one `execute` call that does the whole job over many small tool calls; only what you print() or return comes back.',
    },
  )
  server.registerTool(
    'execute',
    {
      description: `Run JavaScript in a persistent sandboxed REPL. Top-level await works; top-level variables survive between calls. Only print() output and the value of the last expression are returned. No require/import/process. Available API:\n\n${declarations}`,
      inputSchema: { code: z.string().describe('JavaScript source to run') },
    },
    async ({ code }) => {
      const r = await repl.execute(code)
      const denied = r.effects.flatMap(describeDenial)
      const text = [
        r.output,
        r.error,
        denied.length && `[sandbox denied]\n${denied.join('\n')}`,
        `[step ${r.step}]`,
      ]
        .filter(Boolean)
        .join('\n')
      return { content: [{ type: 'text', text }], isError: Boolean(r.error) }
    },
  )
  const closed = new Promise<void>(resolve => (server.server.onclose = resolve))
  await server.connect(new StdioServerTransport())
  await closed
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
