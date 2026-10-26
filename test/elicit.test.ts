import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { askThroughClient } from '../src/adapters/mcp/server.js'
import { Gate } from '../src/core/policy/gate.js'

const policy = { irreversible: [{ net: { host: 'github.com', method: 'POST' } }] }
const push = () => new Request('https://github.com/a/b.git/git-receive-pack', { method: 'POST' })

async function connect(gate: Gate, answer?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
  const server = new McpServer({ name: 'envgit', version: '0' })
  askThroughClient(server, gate)
  const client = new Client({ name: 't', version: '0' }, answer ? { capabilities: { elicitation: { form: {} } } } : {})
  if (answer) client.setRequestHandler(ElicitRequestSchema, req => answer(req.params.message))
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  await new Promise(r => setTimeout(r, 10))
  return { server, client }
}

describe('approval through MCP elicitation', () => {
  it('asks the client and follows its answer', async () => {
    const messages: string[] = []
    let allow = true
    const gate = new Gate(policy)
    await connect(gate, m => (messages.push(m), { action: 'accept', content: { allow } }))
    expect((await gate.filterRequest(push())).action).toBe('allow')
    allow = false
    expect((await gate.filterRequest(push())).action).toBe('deny')
    expect(messages[0]).toMatch(/POST github.com\/a\/b.git\/git-receive-pack/)
  })

  it('a decline or cancel denies', async () => {
    const gate = new Gate(policy)
    await connect(gate, () => ({ action: 'decline' }))
    const d = await gate.filterRequest(push())
    expect(d).toMatchObject({ action: 'deny' })
    expect(d.reason).toMatch(/was not approved/)
  })

  it('a client without elicitation leaves ask rules denying', async () => {
    const gate = new Gate(policy, undefined, 'no MCP client that can ask (elicitation)')
    await connect(gate)
    expect((await gate.filterRequest(push())).reason).toMatch(/there is no MCP client that can ask/)
  })
})
