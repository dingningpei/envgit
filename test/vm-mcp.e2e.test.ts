import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

/** A dependency-free MCP server for the guest (it has node, not envgit's node_modules). */
const STUB = `
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
const tools = [
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'deploy', description: 'POST /deploy.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
]
const text = t => ({ content: [{ type: 'text', text: String(t) }] })
const call = ({ name, arguments: a }) =>
  name === 'add' ? text(a.a + a.b) : text(execFileSync('curl', ['-s', '--noproxy', '', '-X', 'POST', '-w', ' %{http_code}', a.url], { encoding: 'utf8' }))
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.id === undefined) continue
  const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
    : m.method === 'tools/list' ? { tools } : m.method === 'tools/call' ? call(m.params) : {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
}
`

// The REPL worker inside L2 (needs scripts/vm/build.sh and opt-in, like vm.e2e).
describe.skipIf(process.env.ENVGIT_VM_E2E !== '1')('envgit mcp on the vm backend (e2e, ENVGIT_VM_E2E=1)', () => {
  let dir: string
  let client: Client
  let server: http.Server
  let base: string
  const hits: string[] = []
  const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  const execute = async (code: string) => {
    const r = (await client.callTool({ name: 'execute', arguments: { code } })) as { content: { text: string }[]; isError?: boolean }
    return r.content[0]!.text.trim()
  }

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('from host')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    // In L2, 127.0.0.1 is L2's own loopback and in NO_PROXY; the REPL's fetch sends plain HTTP to the
    // proxy regardless (and the stub's curl is told to), where it names the host's loopback. Not the
    // IPv4-mapped [::ffff:127.0.0.1]: with request rules on, srt refuses IPv6-literal targets (§4).
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-vm-mcp-')))
    await envgit('init')
    // In the workdir, so `vm up` copies it into /work, where the worker (cwd /work) starts it.
    await writeFile(join(dir, 'stub.mjs'), STUB)
    await writeFile(
      join(dir, '.envgit/policy.yaml'),
      `backend: vm
network:
  allow: ["127.0.0.1"]
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
capabilities:
  fs: true
  http: true
mcp:
  stub: { command: node, args: [stub.mjs] }
`,
    )
    expect((await envgit('vm', 'up')).stderr).toMatch(/vm up in/)
    client = new Client({ name: 'envgit-test', version: '0' })
    // The SDK passes the child only a few variables by default; ENVGIT_VM_DIR (if set) must reach it.
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: dir, env, stderr: 'ignore' }))
  }, 180_000)

  afterAll(async () => {
    await client?.close()
    if (dir) await envgit('vm', 'down')
    server?.close()
  }, 60_000)

  it('runs the REPL inside the VM, on the workdir there', async () => {
    expect(await execute('let x = 1; x + 1')).toBe('2')
    expect(await execute('await fs.writeFile("from-repl.txt", "hi"); x')).toBe('1')
    // The step's file change reached the host mirror.
    expect(await readFile(join(dir, 'from-repl.txt'), 'utf8')).toBe('hi')
    // Data in, counted by the guest's worker, reaches the step (design §3.3).
    expect(await execute('(await fs.readFile("from-repl.txt")).length')).toBe('2')
    const log = (await envgit('log')).stdout.trim().split('\n')
    expect(log.at(-2)).toMatch(/in 2 out 2$/)
  }, 120_000)

  it('rewind brings the REPL variables back to that step', async () => {
    await execute('x = 2')
    const head = Number(/head: (\d+)/.exec((await envgit('log')).stdout)![1])
    await execute('x = 3')
    expect((await envgit('rewind', String(head))).stderr).toMatch(/rewound to step/)
    const out = await execute('x')
    expect(out).toMatch(/the REPL is back as it was then/)
    expect(out.split('\n').at(-1)).toBe('2')
  }, 120_000)

  it('keeps network access across steps in the long-lived worker', async () => {
    expect(await execute(`await (await fetch("${base}/one")).text()`)).toBe('from host')
    expect(await execute(`await (await fetch("${base}/two")).text()`)).toBe('from host')
    // Two in one step: a kept-alive connection must not carry a second request without the token.
    expect(await execute(`(await (await fetch("${base}/three")).text()) + (await (await fetch("${base}/four")).text())`)).toBe('from hostfrom host')
    expect(hits).toEqual(['GET /one', 'GET /two', 'GET /three', 'GET /four'])
  }, 120_000)

  it('starts MCP servers in the guest: tools as functions, their requests through the gate', async () => {
    const { tools } = await client.listTools()
    expect(tools[0]!.description).toMatch(/declare const stub: \{\n {2}\/\*\* Add two numbers\. \*\/\n {2}add\(args: \{/)
    expect(await execute('await stub.add({ a: 2, b: 3 })')).toBe('5')
    expect(await execute(`await stub.deploy({ url: "${base}/deploy" })`)).toMatch(/envgit: POST .*\/deploy is irreversible[\s\S]* 403/)
    expect(hits).not.toContain('POST /deploy')
  }, 120_000)
})
