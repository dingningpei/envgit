import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '../src/core/snapshot/log.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

/**
 * Stands in for claude, running where `envgit claude` puts it: inside envgit's srt, behind the gate.
 * It runs its hooks like Claude Code (through the relay), and around one Bash call probes the sandbox.
 */
const AGENT = `
import { execSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1])
const fire = (event, payload) => execSync(settings.hooks[event][0].hooks[0].command, { input: JSON.stringify(payload) }).toString()
const out = { sandbox: settings.sandbox, rest: process.argv.slice(process.argv.indexOf('--settings') + 2) }

const write = { tool_name: 'Bash', tool_input: { command: 'echo hi > out.txt' }, tool_use_id: 't1' }
out.pre = fire('PreToolUse', write)
execSync('echo hi > out.txt')
fire('PostToolUse', write)

// Outside the policy's write paths: the sandbox refuses.
try { writeFileSync(process.env.PROBE, 'x'); out.probe = 'written' } catch (e) { out.probe = e.code }
// A host the policy does not allow: the proxy refuses.
out.offList = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://example.com/'], { encoding: 'utf8' }).stdout
// An irreversible POST: no shell rule matches it; the gate stops it at the request.
const deploy = { tool_name: 'Bash', tool_input: { command: 'curl -X POST ' + process.env.BASE + '/deploy' }, tool_use_id: 't2' }
out.deployPre = fire('PreToolUse', deploy)
out.deploy = spawnSync('curl', ['-s', '--noproxy', '', '-X', 'POST', '-w', ' %{http_code}', process.env.BASE + '/deploy'], { encoding: 'utf8' }).stdout
// The same POST inside a CONNECT tunnel, which the gate cannot see into: refused, not let through.
out.tunnel = spawnSync('curl', ['-s', '-p', '--noproxy', '', '-X', 'POST', process.env.BASE + '/deploy'], { encoding: 'utf8' }).stdout
// curl -f-style failure, as a refused git push is: Claude Code fires PostToolUseFailure, not PostToolUse.
fire('PostToolUseFailure', { ...deploy, error: 'exit 22' })
fire('Stop', {})
console.log(JSON.stringify(out))
`

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit claude: the whole agent in srt behind the gate (e2e, needs `npm run build`)', () => {
  let dir: string
  let server: http.Server
  let base: string
  const hits: string[] = []
  const probe = join(homedir(), `.envgit-sandbox-probe-${process.pid}`)

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('done')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-claude-sb-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    // Only a net rule: whatever stops the POST is the gate, not command-line matching.
    await writeFile(
      join(dir, '.envgit', 'policy.yaml'),
      `filesystem:
  write: { allow: ["."] }
network:
  allow: ["127.0.0.1"]
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
`,
    )
    await writeFile(join(dir, 'agent.mjs'), AGENT)
  }, 30_000)

  afterAll(async () => {
    server?.close()
    await rm(probe, { force: true })
  })

  it('refuses to start without credentials in the environment (the keychain login is out of reach)', async () => {
    const env = { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]) }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], { cwd: dir, env }).catch((e: { code: number; stderr: string }) => e)
    expect('code' in r && r.code).toBe(1)
    expect(r.stderr).toMatch(/Set CLAUDE_CODE_OAUTH_TOKEN \(create one with `claude setup-token`\) or ANTHROPIC_API_KEY/)
  })

  it('runs claude inside srt: its own sandbox off, writes and hosts confined, the POST stopped at the request, steps recorded', async () => {
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], {
      cwd: dir,
      env: { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]), PROBE: probe, BASE: base, ANTHROPIC_API_KEY: 'test-key-not-real' },
    })
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!)
    expect(out.sandbox).toEqual({ enabled: false })
    expect(out.rest).toEqual(['-p', 'hello'])
    expect(out.pre).toBe('')
    expect(out.probe).toMatch(/EPERM|EACCES|EROFS/)
    expect(out.offList).toBe('403')
    expect(out.deployPre).toBe('') // nothing on the command line to refuse
    expect(out.deploy).toMatch(/403$/)
    expect(out.tunnel).not.toMatch(/done/)
    expect(hits).not.toContain('POST /deploy')

    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const steps = (await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Step)
    expect(JSON.parse(steps[0]!.action.input)).toEqual(['echo hi > out.txt'])
    expect(steps[0]!.effects).toContainEqual({ kind: 'fs', op: 'write', path: 'out.txt' })
    const deployStep = steps.find(s => s.agent?.toolUseId === 't2')!
    expect(deployStep.exitCode).toBe(1)
    expect(deployStep.effects).toContainEqual(
      expect.objectContaining({ kind: 'net', method: 'POST', path: '/deploy', denied: true, irreversible: expect.objectContaining({ decision: 'denied' }) }),
    )
    // The proxy's refusal of the off-list host is recorded at once; the write probe's comes from the macOS
    // violation log, which can lag onto a later step, and Linux does not report it — so it is not counted.
    const all = steps.flatMap(s => s.effects)
    expect(all).toContainEqual(expect.objectContaining({ kind: 'policy', reason: expect.stringMatching(/network-outbound example\.com:80/) }))
    // srt's system-lookup noise is left out, and no checkpoint is recorded for nothing.
    expect(all.every(e => e.kind !== 'policy' || /\b(file|network)-|\bhttp-request /.test(e.reason))).toBe(true)
    expect(all).toContainEqual(expect.objectContaining({ kind: 'policy', reason: expect.stringMatching(/http-request CONNECT .*tunnel carries no TLS/) }))
    expect(steps.filter(s => s.action.type === 'checkpoint').every(s => s.effects.length > 0)).toBe(true)
    expect((await run(process.execPath, [CLI, 'log'], { cwd: dir })).stdout).toMatch(/curl -X POST .* \d+ denied/)
  }, 60_000)
})
