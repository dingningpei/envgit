import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '../src/core/snapshot/log.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
// The stub lives outside the repo, so it imports by absolute URL.
const SDK = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/', import.meta.url).href
const ZOD = pathToFileURL(createRequire(import.meta.url).resolve('zod')).href
const run = promisify(execFile)

/** An MCP server of the kind the bridge connects: it runs inside envgit's sandbox, started by the REPL worker. */
const STUB = `
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { McpServer } from '${SDK}mcp.js'
import { StdioServerTransport } from '${SDK}stdio.js'
import { z } from '${ZOD}'
const server = new McpServer({ name: 'stub', version: '0' })
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] })
server.registerTool('add', { description: 'Add two numbers.', inputSchema: { a: z.number().describe('first'), b: z.number() } }, ({ a, b }) => text(a + b))
server.registerTool('get-issue', { description: 'One issue.', inputSchema: { number: z.number(), state: z.enum(['open', 'closed']).optional() } }, ({ number }) =>
  text({ number, title: 'stub issue', labels: [{ name: 'bug' }] }))
server.registerTool('token', { description: 'Which token it got.' }, () => text((process.env.STUB_TOKEN ?? '') + ' ' + Object.keys(process.env).filter(k => k.startsWith('ENVGIT_')).length))
server.registerTool('fail', { description: 'Always fails.' }, () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }))
// Its own request and file write, as a server's would be: the gate and the sandbox see them.
server.registerTool('deploy', { description: 'POST /deploy.' }, () =>
  text(execFileSync('curl', ['-s', '--noproxy', '', '-X', 'POST', '-w', ' %{http_code}', process.env.BASE + '/deploy'], { encoding: 'utf8' })))
server.registerTool('note', { description: 'Write note.txt.' }, () => (writeFileSync('note.txt', 'from the server'), text('ok')))
server.registerTool('big', { description: 'A large result.' }, () => text(JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: i, body: 'b'.repeat(40) })))))
server.registerTool('hidden', { description: 'Filtered out by the policy.' }, () => text('should not be reachable'))
await server.connect(new StdioServerTransport())
`

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('MCP servers as REPL functions (e2e, needs `npm run build`)', () => {
  let dir: string
  let server: http.Server
  let base: string
  let stub: string
  const hits: string[] = []
  const clients: Client[] = []

  const connect = async (...args: string[]) => {
    const client = new Client({ name: 'envgit-test', version: '0' })
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', ...args], cwd: dir, env: { ...env, ENVGIT_TEST_TOKEN: 'tok-123' }, stderr: 'ignore' }))
    clients.push(client)
    return client
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0]!.text.trim()

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('done')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-mcp-bridge-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    stub = join(dir, '..', `${dir.split('/').at(-1)}-stub.mjs`)
    await writeFile(stub, STUB)
    await writeFile(
      join(dir, '.envgit', 'policy.yaml'),
      `filesystem:
  write: { allow: ["."] }
network:
  allow: ["127.0.0.1"]
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
capabilities:
  fs: true
  stub: [add, get-issue, token, fail, deploy, note, big]
mcp:
  stub:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(stub)}]
    env: { STUB_TOKEN: "\${ENVGIT_TEST_TOKEN}", BASE: "${base}" }
`,
    )
  }, 30_000)

  afterAll(async () => {
    for (const c of clients) await c.close()
    server?.close()
    if (stub) await rm(stub, { force: true })
  })

  it('declares each tool from its schema, without the filtered ones', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const d = tools[0]!.description!
    expect(d).toContain('declare const stub: {')
    expect(d).toMatch(/\/\*\* Add two numbers\. \*\/\n {2}add\(args: \{\n\s+\/\*\* first \*\/\n\s+a: number\n\s+b: number\n\s+\}\): Promise<unknown>/)
    expect(d).toMatch(/"get-issue"\(args: \{\n\s+number: number\n\s+state\?: "open" \| "closed"/)
    expect(d).toContain('declare const fs')
    expect(d).not.toContain('hidden')
  }, 60_000)

  it('calls the tools as async functions, results as values', async () => {
    const client = clients[0]!
    const execute = async (code: string) => text(await client.callTool({ name: 'execute', arguments: { code } }))
    expect(await execute('await stub.add({ a: 1, b: 2 }) * 10')).toBe('30')
    expect(await execute('const i = await stub["get-issue"]({ number: 7 }); i.labels[0].name + " " + i.number')).toBe('bug 7')
    // ${VAR} in the server's env came from envgit's environment; envgit's own variables (the server
    // list, with every server's tokens) did not reach it.
    expect(await execute('await stub.token()')).toBe('tok-123 0')
    expect(await execute('await stub.fail().catch(e => e.message)')).toBe('stub.fail: nope')
    expect(await execute('typeof stub.hidden')).toBe('undefined')
    // A large result stays in the sandbox; the model gets its type and works on it there.
    expect(await execute('await stub.big()')).toMatch(/^\$1 = Array\(1000\): \d+ characters [^\n]*Type: \{ id: number; body: string \}\[\]/)
    expect(await execute('$1.length')).toBe('1000')
  }, 60_000)

  it("puts the server inside the sandbox: its irreversible POST is stopped at the gate, its write lands on the step", async () => {
    const client = clients[0]!
    const execute = async (code: string) => text(await client.callTool({ name: 'execute', arguments: { code } }))
    expect(await execute('await stub.deploy()')).toMatch(/envgit: POST 127\.0\.0\.1\/deploy is irreversible[^\n]*\n 403\n[\s\S]*\[sandbox denied\]\nnet POST 127\.0\.0\.1\/deploy/)
    expect(hits).not.toContain('POST /deploy')
    expect(await execute('await stub.note()')).toBe('ok')
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('from the server')

    const [id] = await readdir(join(dir, '.envgit', 'sessions'))
    const steps = (await readFile(join(dir, '.envgit', 'sessions', id!, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Step)
    const deploy = steps.find(s => s.action.input === 'await stub.deploy()')!
    expect(deploy.effects).toContainEqual(expect.objectContaining({ kind: 'net', method: 'POST', path: '/deploy', denied: true }))
    expect(steps.find(s => s.action.input === 'await stub.note()')!.effects).toContainEqual({ kind: 'fs', op: 'write', path: 'note.txt' })
  }, 60_000)

  it('serves the same functions as one tool each with --tools, schemas as the server gave them', async () => {
    const client = await connect('--tools')
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['add', 'big', 'deploy', 'fail', 'get-issue', 'note', 'readFile', 'readdir', 'token', 'writeFile'])
    expect(tools.find(t => t.name === 'get-issue')!.inputSchema).toMatchObject({ properties: { state: { enum: ['open', 'closed'] } }, required: ['number'] })
    expect(text(await client.callTool({ name: 'add', arguments: { a: 2, b: 5 } }))).toBe('7')
    expect(text(await client.callTool({ name: 'get-issue', arguments: { number: 3 } }))).toMatch(/"title": "stub issue"/)
    // As a tool result, whole: no handle, no cut.
    expect(JSON.parse(text(await client.callTool({ name: 'big', arguments: {} })))).toHaveLength(1000)
  }, 60_000)

  it('refuses to start when a server will not, saying which', async () => {
    const bad = await realpath(await mkdtemp(join(tmpdir(), 'envgit-mcp-bad-')))
    await mkdir(join(bad, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(bad, '.envgit', 'policy.yaml'), 'mcp:\n  broken: { command: /nonexistent/mcp-server }\n')
    const r = await run(process.execPath, [CLI, 'mcp'], { cwd: bad }).catch((e: { code: number; stderr: string }) => e)
    expect('code' in r && r.code).toBe(1)
    expect(r.stderr).toMatch(/MCP server broken: .*ENOENT/)
  }, 60_000)

  it('turns the old github capability into a clear error', async () => {
    const old = await realpath(await mkdtemp(join(tmpdir(), 'envgit-mcp-old-')))
    await mkdir(join(old, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(old, '.envgit', 'policy.yaml'), 'capabilities:\n  github: [listIssues]\n')
    const r = await run(process.execPath, [CLI, 'mcp'], { cwd: old }).catch((e: { code: number; stderr: string }) => e)
    expect(r.stderr).toMatch(/capabilities\.github: the built-in GitHub functions are gone; connect GitHub's MCP server under mcp\.github/)
  })
})
