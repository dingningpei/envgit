import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

// Plain HTTP to a local server: the gate judges it the same way as TLS-terminated HTTPS, without
// needing the network in the test suite.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('irreversible gating (e2e, needs `npm run build`)', () => {
  let dir: string
  let server: http.Server
  let base: string
  const hits: string[] = []
  const envgit = (...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  // The sandbox sets NO_PROXY for loopback; clear it so the request goes through the proxy like any other.
  const curl = (method: string, path: string) => ['curl', '-s', '--noproxy', '', '-X', method, '-w', ' %{http_code}', `${base}${path}`]
  const steps = async () => {
    const session = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    return (await readFile(join(dir, '.envgit/sessions', session, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  }

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('done')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-gate-')))
    await envgit('init')
    await writeFile(
      join(dir, '.envgit/policy.yaml'),
      `network:
  allow: ["127.0.0.1"]
  l7:
    "127.0.0.1": { paths: ["/api/**", "/deploy", "/notify", "/delete"] }
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
  - net: { host: "127.0.0.1", method: POST, path: "/notify" }
    action: allow
  - net: { host: "127.0.0.1", method: DELETE }
    action: deny
  - shell: ["rm -rf /"]
    action: deny
`,
    )
  }, 30_000)

  afterAll(() => server?.close())

  it('lets ordinary requests through untouched', async () => {
    const r = await envgit('run', ...curl('GET', '/api/x'))
    expect(r.stdout).toBe('done 200')
    expect(hits).toContain('GET /api/x')
  }, 30_000)

  it('denies an ask rule when there is no terminal, and says how to allow it', async () => {
    const r = await envgit('run', ...curl('POST', '/deploy'))
    expect(r.stdout).toMatch(/needs approval.*action: allow[^]*403$/)
    expect(r.stderr).toMatch(/denied POST 127\.0\.0\.1\/deploy/)
    expect(hits).not.toContain('POST /deploy')
    const step = (await steps()).at(-1)
    expect(step.irreversible).toBeUndefined()
    expect(step.effects).toContainEqual(expect.objectContaining({ kind: 'net', method: 'POST', path: '/deploy', denied: true, irreversible: expect.objectContaining({ decision: 'denied' }) }))
    // Once, as the gate's effect — not again as srt's copy of the same denial.
    expect(step.effects.filter((e: { kind: string; reason?: string }) => e.kind === 'policy' && /http-request/.test(e.reason ?? ''))).toEqual([])
  }, 30_000)

  it('asks at the terminal and lets it through on yes, marking the step', async () => {
    // script(1) gives envgit a pseudo-terminal. Its stdin must be a real pipe (not a Node socket), fed
    // "y" once the prompt is on screen — signalled by the test creating a file.
    const ready = join(dir, '.envgit', 'answer-now')
    const cmd = [process.execPath, CLI, 'run', ...curl('POST', '/deploy')].map(a => `'${a}'`).join(' ')
    const inner = process.platform === 'darwin' ? `script -q /dev/null ${cmd}` : `script -qec "${cmd.replace(/"/g, '\\"')}" /dev/null`
    const out = await new Promise<string>((resolve, reject) => {
      const q = spawn('sh', ['-c', `(while [ ! -e '${ready}' ]; do sleep 0.1; done; echo y; sleep 1) | ${inner}`], { cwd: dir })
      let o = ''
      q.stdout.on('data', d => {
        o += d
        if (/allow it\?/.test(o)) void writeFile(ready, '')
      })
      q.on('error', reject)
      q.on('close', () => resolve(o))
    })
    expect(out).toMatch(/irreversible action.*POST 127\.0\.0\.1\/deploy/s)
    expect(out).toMatch(/done 200/)
    expect(hits).toContain('POST /deploy')
    expect((await steps()).at(-1).irreversible.reason).toMatch(/net POST 127\.0\.0\.1 \/deploy .*approved/)
    expect((await envgit('log')).stdout).toMatch(/irreversible: net POST/)
  }, 60_000)

  it('allow rules go out without asking but still mark the step; deny rules never go out', async () => {
    expect((await envgit('run', ...curl('POST', '/notify'))).stdout).toBe('done 200')
    expect((await steps()).at(-1).irreversible.reason).toMatch(/allowed/)
    expect((await envgit('run', ...curl('DELETE', '/delete'))).stdout).toMatch(/policy denies it\s+403$/)
    expect(hits).not.toContain('DELETE /delete')
  }, 30_000)

  it('enforces network.l7', async () => {
    const r = await envgit('run', ...curl('GET', '/admin'))
    expect(r.stdout).toMatch(/not allowed by network.l7 [^]*403$/)
    expect(hits).not.toContain('GET /admin')
  }, 30_000)

  it('refuses plain HTTP inside a CONNECT tunnel, which the gate could not see into', async () => {
    // curl -p tunnels even http:// through CONNECT; before refuseOpaqueTunnels this POST went out unjudged.
    const before = hits.length
    const r = await envgit('run', 'curl', '-s', '-p', '--noproxy', '', '-X', 'POST', '-w', ' %{http_code}', `${base}/deploy`)
    expect(hits.slice(before)).toEqual([])
    expect(r.stdout).not.toMatch(/done/)
    const step = (await steps()).at(-1)
    expect(step.effects).toContainEqual({ kind: 'policy', denied: true, reason: expect.stringMatching(/^deny http-request CONNECT 127\.0\.0\.1:\d+ \(tunnel carries no TLS and cannot be inspected\)$/) })
  }, 30_000)

  it('refuses a request whose Host header names another host than its target', async () => {
    const r = await envgit('run', 'curl', '-s', '--noproxy', '', '-H', 'Host: elsewhere.example', '-w', ' %{http_code}', `${base}/api/x`)
    expect(r.stdout).toMatch(/Host header does not match the request target\s+421$/)
  }, 30_000)

  it('refuses a denied command line before it starts', async () => {
    const n = (await steps()).length
    const r = await envgit('run', 'rm', '-rf', '/')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/is irreversible \(shell: rm -rf \/\) and the policy denies it/)
    expect((await steps()).length).toBe(n)
  }, 30_000)
})
