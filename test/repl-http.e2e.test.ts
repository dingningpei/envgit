import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))

// The REPL's fetch with request rules on: http:// must reach the gate, not be refused as a tunnel.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('REPL fetch through the gate on srt (e2e, needs `npm run build`)', () => {
  let dir: string
  let client: Client
  let server: http.Server
  let base: string
  const hits: string[] = []
  const execute = async (code: string) => {
    const r = await client.callTool({ name: 'execute', arguments: { code } })
    return (r.content as { text: string }[])[0]!.text.trim()
  }

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('from host')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-repl-http-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(
      join(dir, '.envgit', 'policy.yaml'),
      `network:
  allow: ["127.0.0.1"]
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
capabilities:
  http: true
`,
    )
    client = new Client({ name: 'envgit-test', version: '0' })
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: dir, env, stderr: 'ignore' }))
  }, 30_000)

  afterAll(async () => {
    await client?.close()
    server?.close()
  })

  it('lets plain HTTP through the gate and stops the irreversible POST there', async () => {
    // Plain HTTP always goes to the proxy (loopback included), where the gate sees it.
    expect(await execute(`const r = await fetch('${base}/ok'); await r.text()`)).toMatch(/from host/)
    expect(await execute(`const d = await fetch('${base}/deploy', { method: 'POST' }); d.status + ' ' + (await d.text())`)).toMatch(/403 envgit: POST 127\.0\.0\.1\/deploy is irreversible/)
    expect(hits).toEqual(['GET /ok'])
  }, 30_000)

  it('counts a response body as data in, and still hands the code a whole Response', async () => {
    expect(await execute(`const r2 = await fetch('${base}/ok'); [r2.status, r2.ok, r2.headers.get('content-length'), await r2.text()].join(' ')`)).toBe('200 true 9 from host')
    const [id] = await readdir(join(dir, '.envgit', 'sessions'))
    const last = (await readFile(join(dir, '.envgit', 'sessions', id!, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).at(-1)
    expect(last.data).toEqual({ in: 9, out: Buffer.byteLength('200 true 9 from host\n') })
  }, 30_000)
})
