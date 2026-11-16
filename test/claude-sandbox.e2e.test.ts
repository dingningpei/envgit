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
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1])
const fire = (event, payload) => execSync(settings.hooks[event][0].hooks[0].command, { input: JSON.stringify(payload) }).toString()
const out = { sandbox: settings.sandbox, rest: process.argv.slice(process.argv.indexOf('--settings') + 2), matcher: settings.hooks.PreToolUse[0].matcher }
const decision = s => (s.trim() ? JSON.parse(s).hookSpecificOutput.permissionDecision : '')
if (process.env.ASK_ONLY) {
  // Print mode: nobody will see a prompt, so the shell \`ask\` rule refuses, and the refusal is a step.
  const o = JSON.parse(fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'a1' })).hookSpecificOutput
  console.log(JSON.stringify({ decision: o.permissionDecision, reason: o.permissionDecisionReason, edit: decision(fire('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'out.txt' } })) }))
  process.exit(0)
}
if (process.env.TOKEN_ONLY) {
  // Started from the token file: the token is in the environment, the file out of reach.
  out.token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  try { readFileSync(process.env.ENVGIT_CLAUDE_TOKEN_FILE); out.tokenFile = 'read' } catch (e) { out.tokenFile = e.code }
  console.log(JSON.stringify(out))
  process.exit(0)
}

const write = { tool_name: 'Bash', tool_input: { command: 'echo hi > out.txt' }, tool_use_id: 't1' }
out.pre = decision(fire('PreToolUse', write))
// No rule names these either: the policy answers for each, so Claude Code asks nobody.
out.editPre = decision(fire('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'out.txt' } }))
out.mcpPre = decision(fire('PreToolUse', { tool_name: 'mcp__github__list_issues', tool_input: {} }))
// A shell rule still decides: ask goes to Claude Code's prompt, also for Monitor's command line.
out.askPre = decision(fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }))
out.monitorPre = decision(fire('PreToolUse', { tool_name: 'Monitor', tool_input: { command: 'git push origin main' } }))
// Claude Code's user-level config, which later sessions load outside any sandbox: not writable.
// (Probed with a directory nothing uses, made and removed, so a failing deny leaves nothing behind.
// On Linux srt blocks a deny path that does not exist yet by mounting /dev/null on it: ENOTDIR.)
const styles = join(homedir(), '.claude', 'output-styles')
const had = existsSync(styles)
try { mkdirSync(join(styles, 'envgit-probe'), { recursive: true }); rmdirSync(join(styles, 'envgit-probe')); if (!had) rmdirSync(styles); out.userConfig = 'writable' } catch (e) { out.userConfig = e.code }
execSync('echo hi > out.txt')
fire('PostToolUse', write)

// Outside the policy's write paths: the sandbox refuses.
try { writeFileSync(process.env.PROBE, 'x'); out.probe = 'written' } catch (e) { out.probe = e.code }
// A host the policy does not allow: the proxy refuses.
out.offList = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://example.com/'], { encoding: 'utf8' }).stdout
// An irreversible POST: no shell rule matches it; the gate stops it at the request.
const deploy = { tool_name: 'Bash', tool_input: { command: 'curl -X POST ' + process.env.BASE + '/deploy' }, tool_use_id: 't2' }
out.deployPre = decision(fire('PreToolUse', deploy))
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
  let tokens: string

  beforeAll(async () => {
    server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('done')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-claude-sb-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    // No shell rule matches the POST: whatever stops it is the gate, not command-line matching.
    await writeFile(
      join(dir, '.envgit', 'policy.yaml'),
      `filesystem:
  write: { allow: ["."] }
network:
  allow: ["127.0.0.1"]
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
  - shell: ["git push"]
`,
    )
    await writeFile(join(dir, 'agent.mjs'), AGENT)
    tokens = await realpath(await mkdtemp(join(tmpdir(), 'envgit-claude-tok-')))
    // Where Claude Code keeps its state: there on any machine that has run it, not on a CI runner.
    await mkdir(join(homedir(), '.claude'), { recursive: true })
  }, 30_000)

  afterAll(async () => {
    server?.close()
    await rm(probe, { force: true })
    if (tokens) await rm(tokens, { recursive: true, force: true })
  })

  it('refuses to start without a credential in the environment or the token file (the keychain login is out of reach)', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]), ENVGIT_CLAUDE_TOKEN_FILE: join(tokens, 'none') }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], { cwd: dir, env }).catch((e: { code: number; stderr: string }) => e)
    expect('code' in r && r.code).toBe(1)
    expect(r.stderr).toMatch(/Create a token with `claude setup-token` and save it in .*none \(chmod 600\), or set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/)
  })

  it('starts from the token file when the environment has no credential, and keeps the file out of the sandbox', async () => {
    const file = join(tokens, 'claude-oauth-token')
    await writeFile(file, 'token-from-file-not-real\n', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]), ENVGIT_CLAUDE_TOKEN_FILE: file, TOKEN_ONLY: '1' }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    const r = await run(process.execPath, [CLI, 'claude'], { cwd: dir, env })
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!)
    expect(out.token).toBe('token-from-file-not-real')
    expect(out.tokenFile).toMatch(/EPERM|EACCES|ENOENT/)
  }, 60_000)

  it('in print mode refuses an ask rule itself, with a reason to go on by, and records the refusal', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]), ANTHROPIC_API_KEY: 'test-key-not-real', ASK_ONLY: '1' }
    delete env.ENVGIT_UNATTENDED
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], { cwd: dir, env })
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!)
    expect(out.decision).toBe('deny')
    expect(out.reason).toMatch(/`git push origin main` is irreversible \(shell: git push\) and needs approval, but this run is unattended, so it was not run\. Go on with the rest/)
    expect(out.edit).toBe('allow')
    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const steps = (await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Step)
    const refusals = steps.filter(s => s.agent?.toolUseId === 'a1')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ exitCode: 126, effects: [{ kind: 'policy', denied: true, reason: expect.stringMatching(/this run is unattended/) }] })
  }, 60_000)

  it('runs claude inside srt: its own sandbox off, writes and hosts confined, the POST stopped at the request, steps recorded', async () => {
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], {
      cwd: dir,
      // ENVGIT_UNATTENDED=0: someone is at Claude Code's prompt, whatever `-p` and the test's pipes suggest.
      env: { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]), PROBE: probe, BASE: base, ANTHROPIC_API_KEY: 'test-key-not-real', ENVGIT_UNATTENDED: '0' },
    })
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!)
    expect(out.sandbox).toEqual({ enabled: false })
    expect(out.rest).toEqual(['-p', 'hello'])
    expect(out.matcher).toMatch(/Bash.*Edit.*WebFetch.*mcp__/)
    expect(out.pre).toBe('allow')
    expect(out.editPre).toBe('allow')
    expect(out.mcpPre).toBe('allow')
    expect(out.askPre).toBe('ask')
    expect(out.monitorPre).toBe('ask')
    expect(out.userConfig).toMatch(/EPERM|EACCES|EROFS|ENOTDIR/)
    expect(out.probe).toMatch(/EPERM|EACCES|EROFS/)
    expect(out.offList).toBe('403')
    expect(out.deployPre).toBe('allow') // nothing on the command line to refuse
    expect(out.deploy).toMatch(/403$/)
    expect(out.tunnel).not.toMatch(/done/)
    expect(hits).not.toContain('POST /deploy')

    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const steps = (await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Step)
    // (The token-file run before this one may have left a checkpoint: its refused read of the file.)
    const writeStep = steps.find(s => s.agent?.toolUseId === 't1')!
    expect(JSON.parse(writeStep.action.input)).toEqual(['echo hi > out.txt'])
    expect(writeStep.effects).toContainEqual({ kind: 'fs', op: 'write', path: 'out.txt' })
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
    expect(all.every(e => e.kind !== 'policy' || /\b(file|network)-|\bhttp-request |^envgit: /.test(e.reason))).toBe(true) // (or a refusal of envgit's own, from the print-mode run above)
    expect(all).toContainEqual(expect.objectContaining({ kind: 'policy', reason: expect.stringMatching(/http-request CONNECT .*tunnel carries no TLS/) }))
    expect(steps.filter(s => s.action.type === 'checkpoint').every(s => s.effects.length > 0)).toBe(true)
    expect((await run(process.execPath, [CLI, 'log'], { cwd: dir })).stdout).toMatch(/curl -X POST .* \d+ denied/)
  }, 60_000)
})
