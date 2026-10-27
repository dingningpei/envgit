import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '../src/core/snapshot/log.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const POLICY = `filesystem:
  write: { allow: ["."] }
network:
  allow: ["api.github.com:443"]
irreversible:
  - shell: ["git push"]
    action: deny
  - shell: ["npm publish"]
`

/** Runs `envgit hook …` the way an agent does: JSON on stdin, decision on stdout. */
function hook(cwd: string, agent: string, event: string, payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'hook', agent, event], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.on('exit', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

describe('agent hooks (e2e, needs `npm run build`)', () => {
  let dir: string
  const steps = async (): Promise<Step[]> => {
    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const text = await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Step)
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-hooks-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), POLICY)
    await writeFile(join(dir, 'a.txt'), 'one\n')
  })

  it('judges shell commands before Claude Code runs them: deny refuses, ask goes to its prompt', async () => {
    const denied = await hook(dir, 'claude-code', 'pre', { tool_name: 'Bash', tool_input: { command: 'git add -A && git push origin main' }, tool_use_id: 't1' })
    expect(denied.code).toBe(0)
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/irreversible \(shell: git push\) and the policy denies it/)
    const asked = await hook(dir, 'claude-code', 'pre', { tool_name: 'Bash', tool_input: { command: 'npm publish' } })
    expect(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    expect((await hook(dir, 'claude-code', 'pre', { tool_name: 'Bash', tool_input: { command: 'ls' } })).stdout).toBe('')
    // The first hook took the base snapshot, before anything changed.
    const session = JSON.parse(await readFile(join(dir, '.envgit/sessions', (await readFile(join(dir, '.envgit/current'), 'utf8')).trim(), 'session.json'), 'utf8'))
    expect(session.base).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records a step after each tool call that can change files, with the files it changed', async () => {
    await writeFile(join(dir, 'b.txt'), 'new\n') // as Claude's Write tool would
    await hook(dir, 'claude-code', 'post', { tool_name: 'Write', tool_input: { file_path: join(dir, 'b.txt'), content: 'new\n' }, tool_use_id: 'w1', tool_response: {} })
    await writeFile(join(dir, 'a.txt'), 'two\n') // as `sed -i` in Bash would
    await hook(dir, 'claude-code', 'post', { tool_name: 'Bash', tool_input: { command: "sed -i '' s/one/two/ a.txt" }, tool_use_id: 'b1' })
    await hook(dir, 'claude-code', 'post', { tool_name: 'Read', tool_input: { file_path: join(dir, 'a.txt') } })
    const [w, b, ...rest] = await steps()
    expect(rest).toEqual([])
    expect(w!.action).toEqual({ type: 'fs', input: JSON.stringify([{ op: 'write', path: 'b.txt' }]) })
    expect(w!.effects).toEqual([{ kind: 'fs', op: 'write', path: 'b.txt' }])
    expect(w!.agent).toEqual({ name: 'claude-code', tool: 'Write', toolUseId: 'w1' })
    expect(JSON.parse(b!.action.input)).toEqual(["sed -i '' s/one/two/ a.txt"])
    expect(b!.effects).toEqual([{ kind: 'fs', op: 'write', path: 'a.txt' }])
    // And they rewind like any other step.
    const r = await run(process.execPath, [CLI, 'rewind', '0'], { cwd: dir })
    expect(r.stderr).toMatch(/rewound to step 0/)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
  }, 30_000)

  it('checkpoints what changed between tool calls when a turn ends', async () => {
    const before = (await steps()).length
    await hook(dir, 'claude-code', 'stop', {})
    expect((await steps()).length).toBe(before)
    await writeFile(join(dir, 'bg.txt'), 'from a background process\n')
    await hook(dir, 'claude-code', 'stop', {})
    const last = (await steps()).at(-1)!
    expect(last.action.type).toBe('checkpoint')
    expect(last.effects).toEqual([{ kind: 'fs', op: 'write', path: 'bg.txt' }])
  })

  it('speaks Copilot CLI too: camelCase payloads, its decision shape, and an installable hooks file', async () => {
    const denied = await hook(dir, 'copilot', 'pre', { toolName: 'bash', toolArgs: JSON.stringify({ command: 'git push' }), cwd: dir })
    expect(JSON.parse(denied.stdout)).toMatchObject({ permissionDecision: 'deny' })
    await writeFile(join(dir, 'c.txt'), 'c\n')
    await hook(dir, 'copilot', 'post-failed', { toolName: 'create', toolArgs: { path: join(dir, 'c.txt') } })
    const last = (await steps()).at(-1)!
    expect(last).toMatchObject({ exitCode: 1, agent: { name: 'copilot', tool: 'create' } })
    expect((await run(process.execPath, [CLI, 'hooks', 'install', 'copilot'], { cwd: dir })).stderr).toMatch(/wrote \.github\/hooks\/envgit\.json/)
    const cfg = JSON.parse(await readFile(join(dir, '.github/hooks/envgit.json'), 'utf8'))
    expect(cfg.version).toBe(1)
    expect(Object.keys(cfg.hooks)).toEqual(['preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop'])
    expect(cfg.hooks.preToolUse[0].bash).toMatch(/ hook copilot pre$/)
    await run(process.execPath, [CLI, 'hooks', 'uninstall', 'copilot'], { cwd: dir })
    expect(await readdir(join(dir, '.github/hooks'))).toEqual([])
  })

  it('does nothing in a directory envgit does not manage', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'envgit-hooks-none-')))
    const r = await hook(other, 'claude-code', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push' } })
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('runs Claude Code with the hooks and a sandbox compiled from the policy', async () => {
    const d = await realpath(await mkdtemp(join(tmpdir(), 'envgit-claude-')))
    await mkdir(join(d, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(d, '.envgit', 'policy.yaml'), POLICY)
    // Stands in for claude: reads --settings, runs its hooks around one Bash call, prints the sandbox.
    await writeFile(
      join(d, 'agent.mjs'),
      `import { execSync } from 'node:child_process'
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1])
const fire = (event, payload) => execSync(settings.hooks[event][0].hooks[0].command, { input: JSON.stringify(payload) }).toString()
const call = { tool_name: 'Bash', tool_input: { command: 'echo hi > out.txt' }, tool_use_id: 'c1' }
if (fire('PreToolUse', call)) process.exit(3)
execSync('echo hi > out.txt')
fire('PostToolUse', call)
fire('Stop', {})
console.log(JSON.stringify({ sandbox: settings.sandbox, rest: process.argv.slice(process.argv.indexOf('--settings') + 2) }))
`,
    )
    const r = await run(process.execPath, [CLI, 'claude', '-p', 'hello'], { cwd: d, env: { ...process.env, ENVGIT_CLAUDE_AGENT: JSON.stringify([process.execPath, join(d, 'agent.mjs')]) } })
    const out = JSON.parse(r.stdout)
    expect(out.rest).toEqual(['-p', 'hello'])
    expect(out.sandbox).toEqual({
      enabled: true,
      filesystem: { allowRead: [], denyRead: [], allowWrite: [d], denyWrite: [join(d, '.envgit')] },
      network: { allowedDomains: ['api.github.com'], deniedDomains: [] },
    })
    const log = (await run(process.execPath, [CLI, 'log'], { cwd: d })).stdout
    expect(log).toMatch(/exec {2}exit 0 .*echo hi > out\.txt/)
  }, 30_000)
})
