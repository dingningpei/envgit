/**
 * `envgit claude`: the whole Claude Code process runs inside envgit's srt sandbox, behind the gate
 * (docs/design.md §3.4). Its Bash, hooks and MCP servers are its children, so every request any of
 * them makes goes through envgit's proxy, where `network.l7` and irreversible net rules apply —
 * not only command-line matching. Claude Code's own sandbox is turned off for the run, so there is
 * one sandbox, not two nested. Steps are still recorded by its hooks, relayed out of the sandbox.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { Effect } from '../../core/env/backend.js'
import { SrtBackend, toEffect } from '../../core/env/srt.js'
import { Gate } from '../../core/policy/gate.js'
import type { Policy } from '../../core/policy/schema.js'
import { acquireBusy, ensureBase, openSession, releaseBusy, type Snapshotting } from '../../core/snapshot/log.js'
import { runHook, type HookContext } from './handler.js'
import { serveSpool, SPOOL_ENV } from './spool.js'

/** Claude Code's own endpoints (code.claude.com/docs/en/network-config): allowed, never decrypted. */
/** srt denials worth a step: file and network ones with a target (as `envgit log` shows them). */
const RELEVANT_DENIAL = /\b(file|network)-\S+\s+\S/

export const CLAUDE_HOSTS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'mcp-proxy.anthropic.com']

export interface ClaudeRunOptions {
  root: string
  workdir: string
  policy: Policy
  snapshotting: Snapshotting
  /** Argv of the claude binary (tests substitute a stand-in). */
  agent: string[]
  /** Arguments for claude after envgit's own --settings. */
  args: string[]
  /** How a hook inside the sandbox calls envgit: `<node> <cli> hook claude-code <event>`. */
  hookCommand: (event: string) => string
  log: (line: string) => void
}

/**
 * How Claude Code authenticates inside the sandbox: from the environment only. Its usual login lives
 * in the macOS keychain (or ~/.claude/.credentials.json on Linux) and is refreshed in place; a refresh
 * inside the sandbox could rotate the token without being able to save the new one, logging the user
 * out — and keychain access would let any sandboxed command read the token. So neither is reachable.
 */
export const CLAUDE_CREDENTIAL_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']

export function claudeCredentialMissing(env: NodeJS.ProcessEnv): string | undefined {
  if (CLAUDE_CREDENTIAL_ENV.some(k => env[k])) return undefined
  return (
    'envgit claude: Claude Code runs inside envgit\'s sandbox, where it cannot use your keychain login. ' +
    'Set CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`) or ANTHROPIC_API_KEY, then run again.'
  )
}

export async function runClaude(o: ClaudeRunOptions): Promise<number> {
  const missing = claudeCredentialMissing(process.env)
  if (missing) throw new Error(missing)
  const run = join(tmpdir(), `envgit-claude-${randomBytes(6).toString('hex')}`)
  const spool = join(run, 'spool')
  // Claude Code's own temp files (its Bash tool's working dirs among them) go here, not /tmp/claude-<uid>.
  const claudeTmp = join(run, 'tmp')
  await mkdir(spool, { recursive: true })
  await mkdir(claudeTmp, { recursive: true })
  // The base before Claude touches anything.
  await acquireBusy(o.root)
  try {
    await ensureBase(await openSession(o.root, 'srt'), o.snapshotting)
  } finally {
    await releaseBusy(o.root)
  }

  // Claude Code owns the terminal; the exec-server-less hooks protocol has no channel for an approval.
  const gate = new Gate(o.policy, undefined, 'no way to ask while Claude Code holds the terminal')
  const backend = new SrtBackend()
  const home = homedir()
  const env = await backend.create({
    workdir: o.workdir,
    policy: o.policy,
    snapshots: { store: o.snapshotting.store, exclude: o.snapshotting.exclude },
    gate,
    srtExtra: {
      // Claude Code's state, its temp files, and the relay.
      allowWrite: [join(home, '.claude'), join(home, '.claude.json'), `${join(home, '.claude.json')}.*`, join(home, 'Library/Caches/claude-cli-nodejs'), join(home, '.cache/claude'), tmpdir(), claudeTmp, spool],
      // The stored login is out of reach on purpose (see CLAUDE_CREDENTIAL_ENV); no keychain either.
      denyRead: [join(home, '.claude', '.credentials.json')],
      allowedDomains: CLAUDE_HOSTS,
      noInspect: CLAUDE_HOSTS,
      allowPty: true,
    },
  })

  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell|Monitor|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: o.hookCommand('pre'), timeout: 60 }] }],
      PostToolUse: [{ matcher: 'Bash|PowerShell|Monitor|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: o.hookCommand('post'), timeout: 300 }] }],
      Stop: [{ hooks: [{ type: 'command', command: o.hookCommand('stop'), timeout: 300 }] }],
    },
    // envgit's sandbox already wraps the whole process: Claude Code's own would nest inside it.
    sandbox: { enabled: false },
  }

  const { child, commandId } = await backend.spawn(
    env,
    {
      argv: [...o.agent, '--settings', JSON.stringify(settings), ...o.args],
      cwd: o.workdir,
      env: { [SPOOL_ENV]: spool, CLAUDE_CODE_TMPDIR: claudeTmp, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    },
    'inherit',
  )

  // Requests and denials land on the next recorded step: the one whose tool made them, or the turn's end.
  // Claude Code makes many system lookups srt denies (sysctl, mach): noise, left out as `log` leaves it.
  let seen = 0
  const sandboxEffects = (): Effect[] => {
    const v = backend.violations(commandId)
    const fresh = v.slice(seen).map(toEffect).filter(e => e.kind !== 'policy' || RELEVANT_DENIAL.test(e.reason))
    seen = v.length
    return [...backend.gated(), ...fresh]
  }
  const ctx: HookContext = { root: o.root, workdir: o.workdir, policy: o.policy, snapshotting: o.snapshotting, sandboxEffects }
  const server = serveSpool(spool, req => runHook(req.agent, req.event, req.input, ctx), o.log)

  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code, sig) => resolve(code ?? (sig ? 130 : 1)))
    })
  } finally {
    process.off('SIGINT', ignore)
    await server.stop()
    // A crash or Ctrl-C skips Claude Code's Stop hook; checkpoint what is left here.
    await runHook('claude-code', 'stop', '{}', ctx).catch(e => o.log(`envgit: final checkpoint failed: ${e instanceof Error ? e.message : e}`))
    SandboxManager.cleanupAfterCommand()
    await backend.destroy(env)
    await rm(run, { recursive: true, force: true })
  }
}
