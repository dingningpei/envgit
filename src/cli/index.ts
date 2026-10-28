#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCodexWs, serveCodexStdio } from '../adapters/codex/serve.js'
import { httpHelper } from '../adapters/codex/http-helper.js'
import { SrtRunner, VmRunner, type Runner } from '../adapters/codex/runners.js'
import { serveMcp } from '../adapters/mcp/server.js'
import { serveUi } from '../ui/server.js'
import { runHook, type HookEvent } from '../adapters/hooks/handler.js'
import { COPILOT_WRITERS, type Agent } from '../adapters/hooks/normalize.js'
import { runClaude } from '../adapters/hooks/claude-run.js'
import { relay, SPOOL_ENV } from '../adapters/hooks/spool.js'
import { SrtBackend } from '../core/env/srt.js'
import { L2_NET_ENV } from '../core/env/vm-egress.js'
import { recordVmStep, reportMirror, withEgress } from '../core/env/vm-step.js'
import { buildPrebuiltBase, copyVmSnapshots, gcVmSnapshots, tarFrom, VmBackend, VmClient, vmDown, vmPaths, vmImageStamp, vmSnapshotExists, vmStale, vmUp } from '../core/env/vm.js'
import { Gate, irreversibleOf, needsInspection } from '../core/policy/gate.js'
import { ttyApprover } from './approve.js'
import { loadPolicy } from '../core/policy/load.js'
import type { Policy } from '../core/policy/schema.js'
import {
  acquireBusy,
  activeChain,
  busyHolder,
  createSession,
  ensureBase,
  liveSnapshots,
  openSession,
  readHead,
  readPruned,
  readSteps,
  recordStep,
  releaseBusy,
  snapshotOf,
  writeHead,
  writeMeta,
  type OpenSession,
  type Snapshotting,
  type StepRef,
} from '../core/snapshot/log.js'
import type { Effect, SnapshotId } from '../core/env/backend.js'
import { SnapshotStore } from '../core/snapshot/store.js'
import { enforceCap, parseBytes } from '../core/snapshot/cap.js'
import { ReplSession } from '../repl/session.js'
import { VmReplSession } from '../repl/vm-session.js'
import { runWorker } from '../repl/worker.js'

const [cmd = 'help', ...args] = process.argv.slice(2)

const help = `envgit — version control for agent execution environments

  envgit init            create .envgit/ and a default policy
  envgit run <cmd...>    run a command in the sandbox, record a step
  envgit mcp [--tools]   serve the sandboxed REPL as an MCP server on stdio
                         (--tools: one MCP tool per capability instead of execute)
  envgit codex [args...] run Codex with envgit as its environment: each command it runs
                         is a step in the sandbox (srt or vm), each apply_patch a step
  envgit codex-exec-server   the same, as a stdio exec-server for ~/.codex/environments.toml
  envgit claude [args...]  run Claude Code inside envgit's sandbox and gate: each tool call that
                         can change files is a step, every request it makes is judged (srt;
                         needs CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`, or ANTHROPIC_API_KEY)
  envgit hooks install|uninstall copilot   the same hooks for Copilot CLI (.github/hooks/envgit.json)
  envgit log                     show the steps leading to the current state
  envgit ui [--port N] [--open]  the session timeline in a browser: steps, effects, diffs,
                                 rewind and fork (loopback only, a token in the URL)
  envgit rewind <step|base>      restore the workdir to a step (--force drops unrecorded edits)
  envgit fork <step|base> <dir>  materialize a step into a new directory with its own session
  envgit session [new]           print the current session, or start a new one
  envgit gc                      delete snapshots and blobs no session refers to
  envgit vm up [--new]           start the nested-Firecracker VM (policy backend: vm), resuming
                                 the current vm session at its head unless --new
  envgit vm down|status          stop the VM (snapshots stay on disk) / show it
  envgit vm push <path...>       copy host edits into the VM, recorded as a step

Snapshots are fs-level on srt: files only, not memory or processes (backend: vm
keeps those too). A running \`envgit mcp\` resets its REPL after a rewind.

Irreversible actions (policy \`irreversible:\`) are gated: HTTP requests through the
sandbox proxy (TLS-terminated when the policy has request rules) and matching
command lines. \`action: ask\` (default) asks at the terminal, or the MCP client
via elicitation, and denies when no one can be asked; \`deny\` / \`allow\` skip asking.`

const ROOT = join(process.cwd(), '.envgit')
const POLICY = join(ROOT, 'policy.yaml')
const DEFAULT_POLICY = fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url))
/** srt violation lines worth showing: fs, network or proxy refusals with a target, not sysctl/mach noise. */
const RELEVANT_DENIAL = /\b(file|network)-\S+\s+\S|\bhttp-request \S/

function snapshotting(policy: Policy): Snapshotting {
  const store = new SnapshotStore(ROOT)
  const max = policy.snapshot?.maxBytes
  const cap = max === undefined ? undefined : async () => void (await enforceCap({ root: ROOT, workdir: process.cwd(), maxBytes: parseBytes(max), store, log: line => console.error(line) }))
  return { store, workdir: process.cwd(), exclude: policy.snapshot?.exclude ?? [], ...(cap && { cap }) }
}

const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s)

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function init(): Promise<number> {
  if (await exists(POLICY)) {
    console.error(`envgit: ${POLICY} already exists`)
    return 1
  }
  await mkdir(join(ROOT, 'sessions'), { recursive: true })
  await copyFile(DEFAULT_POLICY, POLICY)
  console.log(`initialized ${ROOT}`)
  return 0
}

async function run(argv: string[]): Promise<number> {
  if (argv[0] === '--') argv = argv.slice(1)
  if (argv.length === 0) {
    console.error('usage: envgit run <cmd...>')
    return 2
  }
  const policy = await requireInit()
  const gate = terminalGate(policy)
  const shell = await gate.checkShell(argv)
  if (shell.refused) {
    console.error(red(shell.refused))
    return 1
  }
  if (policy.backend === 'vm') return runVm(argv, policy, gate, shell.irreversible)
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)

  const snap = snapshotting(policy)
  await acquireBusy(ROOT)
  await ensureBase(session, snap)
  const env = await backend.create({ workdir: process.cwd(), policy, snapshots: snap, gate })
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  try {
    const startedAt = new Date().toISOString()
    const result = await backend.exec(env, { argv }, ac.signal)
    const irreversible = shell.irreversible ?? irreversibleOf(result.effects)
    const step = await recordStep(session, snap, {
      startedAt,
      endedAt: new Date().toISOString(),
      action: { type: 'exec', input: JSON.stringify(argv) },
      exitCode: result.exitCode,
      effects: result.effects,
      ...(irreversible && { irreversible: { reason: irreversible } }),
    })
    reportEffects(result.effects)
    console.error(`envgit: step ${step.index} recorded in session ${session.meta.id}`)
    return result.exitCode
  } finally {
    process.off('SIGINT', onSigint)
    await backend.destroy(env)
    await releaseBusy(ROOT)
  }
}

function reportEffects(effects: Effect[]): void {
  for (const e of effects) {
    if (e.kind === 'policy' && RELEVANT_DENIAL.test(e.reason)) console.error(red(`envgit: denied ${e.reason}`))
    if (e.kind === 'net' && e.denied) console.error(red(`envgit: denied ${e.method} ${e.host}${e.path ?? ''}${e.irreversible ? ` (${e.irreversible.rule})` : ' (network.l7)'}`))
    if (e.kind === 'net' && e.irreversible && !e.denied) console.error(red(`envgit: irreversible ${e.method} ${e.host}${e.path ?? ''} went out (${e.irreversible.rule}, ${e.irreversible.decision})`))
  }
}

/** A gate that asks at the terminal when there is one; otherwise `ask` rules deny. */
function terminalGate(policy: Policy): Gate {
  const tty = ttyApprover()
  return tty ? new Gate(policy, tty, 'the terminal') : new Gate(policy)
}

async function mcp(mode: 'repl' | 'tools'): Promise<number> {
  // stdout carries JSON-RPC; keep every diagnostic on stderr.
  console.log = console.error
  const policy = await requireInit()
  // stdin is the MCP transport, so approval goes through the client (elicitation) once it connects.
  const gate = new Gate(policy, undefined, 'no MCP client that can ask (elicitation)')
  if (policy.backend === 'vm') {
    const session = await vmSession(policy)
    const vm = new VmBackend()
    await vm.create({ workdir: process.cwd() })
    const repl = new VmReplSession(vm, policy, session, snapshotting(policy), gate)
    try {
      await serveMcp(repl, policy, process.cwd(), mode, gate)
    } finally {
      await repl.close()
    }
    return 0
  }
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)
  const snap = snapshotting(policy)
  const env = await backend.create({ workdir: process.cwd(), policy, snapshots: snap, gate })
  const repl = new ReplSession(backend, env, policy, session, snap)
  try {
    await serveMcp(repl, policy, process.cwd(), mode, gate)
    return 0
  } finally {
    await repl.close()
    await backend.destroy(env)
  }
}

/** Codex's commands and file operations, through envgit (src/adapters/codex). */
async function codexOptions() {
  const policy = await requireInit()
  // Codex owns the terminal, and the exec-server protocol has no way to ask its user.
  const gate = new Gate(policy, undefined, 'no way to ask from inside Codex')
  const log = (line: string) => console.error(line)
  const workdir = process.cwd()
  const common = { workdir, policy, gate, snapshotting: snapshotting(policy), log }
  // On vm the VM must be up (and on the current build) before Codex starts.
  const vmSess = policy.backend === 'vm' ? await vmSession(policy) : undefined
  const runner = async (): Promise<Runner> => {
    if (!vmSess) return SrtRunner.create(common, await openSession(ROOT, 'srt'))
    const vm = new VmBackend()
    await vm.create({ workdir })
    return new VmRunner(common, vmSess, vm)
  }
  return { workdir, gate, root: ROOT, runner, codexBin: process.env.ENVGIT_CODEX_BIN, log }
}

async function codex(argv: string[]): Promise<number> {
  const o = await codexOptions()
  // ENVGIT_CODEX_AGENT (a JSON argv) stands in for the codex binary as the agent, for tests.
  const agent = process.env.ENVGIT_CODEX_AGENT ? (JSON.parse(process.env.ENVGIT_CODEX_AGENT) as string[]) : [o.codexBin ?? 'codex']
  const code = await runCodexWs(o, [...agent, ...argv])
  const session = await openSession(ROOT, 'srt')
  console.error(`envgit: Codex ran in session ${session.meta.id}; \`envgit log\` shows its steps`)
  return code
}

async function codexExecServer(): Promise<number> {
  // stdout is the transport.
  console.log = console.error
  await serveCodexStdio(await codexOptions())
  return 0
}

async function noSnapshot(session: OpenSession, target: StepRef): Promise<string> {
  const label = target === 'base' ? 'base' : `step ${target}`
  return (await readPruned(session.dir)).has(target)
    ? `${label} can no longer be restored: its snapshot was dropped to stay under snapshot.maxBytes (it stays in the log)`
    : `${label} has no snapshot`
}

/** Claude Code and Copilot CLI run their own tools; envgit records them through hooks (src/adapters/hooks). */
function hookCommand(agent: Agent, event: HookEvent): string {
  return `"${process.execPath}" "${fileURLToPath(import.meta.url)}" hook ${agent} ${event}`
}

async function hook(argv: string[]): Promise<number> {
  const [agent, event] = argv as [Agent, HookEvent]
  if (!['claude-code', 'copilot'].includes(agent) || !['pre', 'post', 'post-failed', 'stop'].includes(event)) throw new Error('usage: envgit hook <claude-code|copilot> <pre|post|post-failed|stop>')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  // Inside `envgit claude`'s sandbox: hand the event to the envgit outside it (it cannot write .envgit).
  const spool = process.env[SPOOL_ENV]
  if (spool) {
    const out = await relay(spool, { agent, event, input }, 280_000).catch(e => (console.error(`envgit: hook relay failed: ${e instanceof Error ? e.message : e}`), undefined))
    if (out === undefined) console.error(`envgit: no answer from envgit for the ${event} hook; going on without it`)
    else if (out) process.stdout.write(out + '\n')
    return 0
  }
  // Installed hooks also fire in directories envgit does not manage: then they do nothing.
  if (!(await exists(POLICY))) return 0
  try {
    const policy = await requireInit()
    if (policy.backend === 'vm') {
      console.error('envgit: hooks record steps with fs-level snapshots on the host; this workdir uses backend: vm, so nothing is recorded')
      return 0
    }
    const out = await runHook(agent, event, input, { root: ROOT, workdir: process.cwd(), policy, snapshotting: snapshotting(policy) })
    if (out) process.stdout.write(out + '\n')
  } catch (e) {
    // Never wedge the agent; a pre hook that fails allows.
    console.error(`envgit: hook ${event} failed: ${e instanceof Error ? e.message : e}`)
  }
  return 0
}

async function claude(argv: string[]): Promise<number> {
  const policy = await requireInit()
  if (policy.backend === 'vm') throw new Error('envgit claude: Claude Code runs on the host, inside srt, so it needs backend: srt (use `envgit mcp` to work inside the VM)')
  // ENVGIT_CLAUDE_AGENT (a JSON argv) stands in for the claude binary, for tests.
  const agent = process.env.ENVGIT_CLAUDE_AGENT ? (JSON.parse(process.env.ENVGIT_CLAUDE_AGENT) as string[]) : ['claude']
  const code = await runClaude({
    root: ROOT,
    workdir: process.cwd(),
    policy,
    snapshotting: snapshotting(policy),
    agent,
    args: argv,
    hookCommand: event => hookCommand('claude-code', event as HookEvent),
    log: line => console.error(line),
  })
  const session = await openSession(ROOT, 'srt')
  console.error(`envgit: Claude Code ran in session ${session.meta.id}; \`envgit log\` shows its steps`)
  return code
}

const COPILOT_HOOKS = join(process.cwd(), '.github', 'hooks', 'envgit.json')

async function hooksCmd(argv: string[]): Promise<number> {
  const [verb, agent] = argv
  if (agent !== 'copilot' || (verb !== 'install' && verb !== 'uninstall')) throw new Error('usage: envgit hooks install|uninstall copilot')
  if (verb === 'uninstall') {
    await rm(COPILOT_HOOKS, { force: true })
    console.error(`envgit: removed ${relative(process.cwd(), COPILOT_HOOKS)}`)
    return 0
  }
  const policy = await requireInit()
  if (policy.backend === 'vm') throw new Error('envgit hooks: Copilot runs its tools on the host, so it needs backend: srt')
  const cmd = (event: HookEvent) => ({ type: 'command', bash: hookCommand('copilot', event), timeoutSec: 300 })
  const config = {
    version: 1,
    hooks: {
      preToolUse: [{ ...cmd('pre'), matcher: COPILOT_WRITERS }],
      postToolUse: [{ ...cmd('post'), matcher: COPILOT_WRITERS }],
      postToolUseFailure: [{ ...cmd('post-failed'), matcher: COPILOT_WRITERS }],
      agentStop: [cmd('stop')],
    },
  }
  await mkdir(join(process.cwd(), '.github', 'hooks'), { recursive: true })
  await writeFile(COPILOT_HOOKS, JSON.stringify(config, null, 2) + '\n')
  console.error(`envgit: wrote ${relative(process.cwd(), COPILOT_HOOKS)} — it names this machine's node and envgit paths, so keep it out of commits. Copilot runs a repository's hooks only in a trusted folder (with -p: --trust-folder)`)
  return 0
}

function parseRef(arg: string | undefined): StepRef {
  if (arg === 'base') return 'base'
  if (arg && /^\d+$/.test(arg)) return Number(arg)
  throw new Error(`expected a step number or "base", got ${arg ?? 'nothing'}`)
}

async function requireInit(): Promise<Policy> {
  if (!(await exists(POLICY))) throw new Error('no .envgit/policy.yaml here — run `envgit init` first')
  const policy = await loadPolicy(POLICY)
  if (policy.snapshot?.maxBytes !== undefined) parseBytes(policy.snapshot.maxBytes)
  // With request rules the gate refuses every tunnel it cannot see into, so a host left undecrypted
  // could not be reached at all: say so here rather than as 403s later.
  if (policy.network?.noInspect?.length && needsInspection(policy)) {
    throw new Error(
      `policy: network.noInspect (${policy.network.noInspect.join(', ')}) cannot be combined with request rules (network.l7 or irreversible net rules): ` +
        'the gate refuses tunnels it cannot inspect, so those hosts would be unreachable. Drop noInspect, or drop the request rules.',
    )
  }
  await recoverRestore(policy)
  return policy
}

const RESTORING = join(ROOT, 'restoring')

interface RestoreMarker {
  session: string
  target: StepRef
  snapshot: SnapshotId
}

/** Restores the workdir and moves head, leaving a marker so an interrupted restore is finished later. */
async function restoreTo(session: OpenSession, snap: Snapshotting, target: StepRef, snapshot: SnapshotId): Promise<void> {
  await writeFile(RESTORING, JSON.stringify({ session: session.meta.id, target, snapshot } satisfies RestoreMarker))
  if (session.meta.backend === 'vm') {
    // Snapshots live on the host, so a stopped VM is simply booted again to restore into.
    await vmUp(process.cwd())
    const vm = new VmBackend()
    await vm.create({ workdir: process.cwd() })
    await vm.restore(snapshot)
    await writeHead(session.dir, target)
    reportMirror(await vm.syncMirror())
  } else {
    await snap.store.restore(snap.workdir, snapshot, snap.exclude)
    await writeHead(session.dir, target)
  }
  await rm(RESTORING)
}

/** Finishes a rewind that was interrupted; restore only touches what differs, so redoing it is safe. */
async function recoverRestore(policy: Policy): Promise<void> {
  const text = await readFile(RESTORING, 'utf8').catch(() => '')
  if (!text) return
  const m = JSON.parse(text) as RestoreMarker
  const session: OpenSession = { dir: join(ROOT, 'sessions', m.session), meta: JSON.parse(await readFile(join(ROOT, 'sessions', m.session, 'session.json'), 'utf8')) }
  if (session.meta.backend === 'vm' && !(await vmSnapshotExists(process.cwd(), m.snapshot))) {
    // Its target is not on disk (taken before snapshots moved to the host, or deleted); nothing can finish it.
    await rm(RESTORING)
    console.error('envgit: dropped an interrupted vm rewind: its snapshot is not on disk')
    return
  }
  await restoreTo(session, snapshotting(policy), m.target, m.snapshot)
  console.error(`envgit: finished an interrupted rewind to ${m.target === 'base' ? 'base' : `step ${m.target}`}`)
}

async function ui(argv: string[]): Promise<number> {
  await requireInit()
  const p = argv.indexOf('--port')
  const port = p >= 0 ? Number(argv[p + 1]) : 0
  if (!Number.isInteger(port) || port < 0) throw new Error('usage: envgit ui [--port N] [--open]')
  const server = await serveUi({ workdir: process.cwd(), root: ROOT, cli: fileURLToPath(import.meta.url), port })
  console.error(`envgit: timeline at ${server.url} (Ctrl-C to stop)`)
  if (argv.includes('--open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  await new Promise<void>(r => process.once('SIGINT', r).once('SIGTERM', r))
  await server.close()
  return 0
}

async function log(): Promise<number> {
  await requireInit()
  if (!(await exists(join(ROOT, 'current')))) {
    console.log('no steps yet')
    return 0
  }
  const session = await openSession(ROOT, 'srt')
  const steps = await readSteps(session.dir)
  const head = await readHead(session.dir)
  const chain = activeChain(steps, head)
  const pruned = await readPruned(session.dir)
  const short = (id?: string) => (id ? id.slice(0, 8) : '--------')
  const from = session.meta.forkedFrom
  console.log(`session ${session.meta.id}${from ? ` (forked from ${from.session} step ${from.step})` : ''}`)
  console.log(`  base  ${pruned.has('base') ? 'pruned  ' : short(session.meta.base)}`)
  for (const st of chain) {
    const input =
      st.action.type === 'exec'
        ? (JSON.parse(st.action.input) as string[]).join(' ').replace(/\s+/g, ' ')
        : st.action.type === 'fs'
          ? (JSON.parse(st.action.input) as { op: string; path: string }[]).map(o => `${o.op} ${o.path}`).join(', ')
          : st.action.input.replace(/\s+/g, ' ')
    const denied = st.effects.filter(e => (e.kind === 'policy' ? RELEVANT_DENIAL.test(e.reason) : 'denied' in e && e.denied)).length
    const cols = [
      String(st.index).padStart(5),
      st.startedAt.slice(11, 19),
      (st.action.type === 'checkpoint' ? 'ckpt' : st.action.type).padEnd(4),
      `exit ${st.exitCode}`.padEnd(7),
      pruned.has(st.index) ? 'pruned  ' : short(st.snapshot),
      (input.length > 60 ? input.slice(0, 59) + '…' : input).padEnd(60),
      denied ? `${denied} denied` : '',
      st.irreversible ? red(`irreversible: ${st.irreversible.reason}`) : '',
    ]
    console.log(cols.join('  ').trimEnd())
  }
  const off = steps.length - chain.length
  console.log(`head: ${head}${off ? ` (${off} step${off > 1 ? 's' : ''} off this branch)` : ''}`)
  return 0
}

async function rewind(args: string[]): Promise<number> {
  const force = args.includes('--force')
  const target = parseRef(args.find(a => a !== '--force'))
  const policy = await requireInit()
  const session = await openSession(ROOT, 'srt')
  const snap = snapshotting(policy)
  const targetId = await snapshotOf(session, target)
  if (!targetId) throw new Error(await noSnapshot(session, target))

  const busy = await busyHolder(ROOT)
  if (busy !== undefined) {
    console.error(`envgit: a step is running here (pid ${busy}); wait for it to finish`)
    return 1
  }
  // Rewinding replaces the guest's state anyway; only make sure it lands in a VM on the current build.
  if (session.meta.backend === 'vm' && session.meta.vmImage !== (await vmImageStamp())) {
    throw new Error(`vm: session ${session.meta.id} was taken on other L2 images (rebuilt since); its snapshots cannot restore onto these`)
  }
  if (session.meta.backend === 'vm' && (await vmStale(process.cwd()))) await vmDown(process.cwd())
  const head = await readHead(session.dir)
  const headId = await snapshotOf(session, head)
  // On vm the guest owns the files and keeps running between steps, so there is no host-side drift to check.
  if (headId && !force && session.meta.backend !== 'vm') {
    const now = await snap.store.snapshot(snap.workdir, snap.exclude, await snap.store.read(headId), { persist: false })
    if (now !== headId) {
      console.error(`envgit: the workdir has changes made outside envgit since step ${head}; rewind --force discards them`)
      return 1
    }
  }

  const steps = await readSteps(session.dir)
  const kept = new Set(activeChain(steps, target).map(s => s.index))
  const undone = activeChain(steps, head).filter(s => !kept.has(s.index))
  for (const s of undone.filter(s => s.irreversible)) {
    console.error(red(`envgit: step ${s.index} cannot be undone (${s.irreversible!.reason}): ${s.action.input}`))
  }
  await restoreTo(session, snap, target, targetId)
  console.error(`envgit: rewound to ${target === 'base' ? 'base' : `step ${target}`} (${undone.length} step(s) undone)`)
  return 0
}

async function fork(args: string[]): Promise<number> {
  const target = parseRef(args[0])
  if (!args[1]) throw new Error('usage: envgit fork <step|base> <dir>')
  const dir = resolve(args[1])
  if (await exists(dir)) throw new Error(`${dir} already exists`)
  // A fork inside the workdir would land in this session's own snapshots and rewinds.
  if (!relative(process.cwd(), dir).startsWith('..')) throw new Error('fork target must be outside the current workdir')
  const policy = await requireInit()
  const session = await openSession(ROOT, 'srt')
  const id = await snapshotOf(session, target)
  if (!id) throw new Error(await noSnapshot(session, target))

  // Built next to the target and renamed into place, so a fork is all or nothing. The temp name is
  // fixed, so a retry after a crash clears what the failed attempt left.
  const tmp = `${dir}.forking`
  if (await exists(tmp)) {
    // Only clear what a previous fork left: it creates `.envgit` first.
    if (!(await exists(join(tmp, '.envgit')))) throw new Error(`${tmp} exists and is not a leftover fork; remove it or choose another target`)
    await rm(tmp, { recursive: true, force: true })
  }
  const root = join(tmp, '.envgit')
  await mkdir(join(root, 'sessions'), { recursive: true })
  await copyFile(POLICY, join(root, 'policy.yaml'))
  if (session.meta.backend === 'vm') return forkVm(session, target, id, tmp, dir)
  const store = new SnapshotStore(root)
  await snapshotting(policy).store.copyTo(store, id)
  await store.restore(tmp, id, policy.snapshot?.exclude ?? [])
  const forked = await openSession(root, 'srt')
  forked.meta.base = id
  forked.meta.forkedFrom = { session: session.meta.id, step: target, snapshot: id }
  await writeMeta(forked)
  await rename(tmp, dir)
  console.error(`envgit: forked ${target === 'base' ? 'base' : `step ${target}`} into ${dir} (session ${forked.meta.id})`)
  return 0
}

/** A vm fork gets the snapshot chain and a session at it, then boots once to fill its mirror. */
async function forkVm(session: OpenSession, target: StepRef, id: SnapshotId, tmp: string, dir: string): Promise<number> {
  await copyVmSnapshots(process.cwd(), tmp, id)
  // The forked guest's processes (the REPL worker) already trust this workdir's proxy CA.
  await cp(join(vmPaths(process.cwd()).state, 'ca'), join(vmPaths(tmp).state, 'ca'), { recursive: true }).catch(() => {})
  const forked = await createSession(join(tmp, '.envgit'), 'vm')
  forked.meta.base = id
  forked.meta.vmImage = session.meta.vmImage
  forked.meta.forkedFrom = { session: session.meta.id, step: target, snapshot: id }
  await writeMeta(forked)
  await rename(tmp, dir)
  const label = target === 'base' ? 'base' : `step ${target}`
  try {
    await vmUp(dir)
    const vm = new VmBackend()
    await vm.create({ workdir: dir })
    await vm.restore(id)
    await vm.syncMirror()
  } catch (e) {
    console.error(`envgit: forked ${label} into ${dir} (session ${forked.meta.id}), but filling its files failed: ${e instanceof Error ? e.message : e}; run \`envgit vm up\` there`)
    return 1
  } finally {
    await vmDown(dir)
  }
  console.error(`envgit: forked ${label} into ${dir} (session ${forked.meta.id}); \`envgit vm up\` there resumes it with memory and processes`)
  return 0
}

async function sessionCmd(args: string[]): Promise<number> {
  const policy = await requireInit()
  if (args[0] === 'new') {
    const session = await createSession(ROOT, 'srt')
    await ensureBase(session, snapshotting(policy))
    console.log(session.meta.id)
    return 0
  }
  if (args.length) throw new Error('usage: envgit session [new]')
  const current = await readFile(join(ROOT, 'current'), 'utf8').catch(() => '')
  console.log(current.trim() || 'no session yet')
  return 0
}

async function gc(): Promise<number> {
  const policy = await requireInit()
  const max = policy.snapshot?.maxBytes
  if (max !== undefined) {
    await acquireBusy(ROOT)
    try {
      const r = await enforceCap({ root: ROOT, workdir: process.cwd(), maxBytes: parseBytes(max), store: new SnapshotStore(ROOT), log: line => console.error(line) }, { force: true })
      if (!r) console.error(`envgit: snapshots are under snapshot.maxBytes (${String(max)})`)
    } finally {
      await releaseBusy(ROOT)
    }
  }
  const live = await liveSnapshots(ROOT)
  const r = await new SnapshotStore(ROOT).gc(live)
  const v = await gcVmSnapshots(process.cwd(), live)
  // Logical size: with APFS clones the disk space actually freed can be smaller.
  console.log(`removed ${r.snapshots + v.snapshots} snapshot(s), ${r.blobs} blob(s), ${r.tmp} leftover temp file(s), ${((r.bytes + v.bytes) / 1e6).toFixed(1)} MB; kept ${live.size} snapshot(s) in use`)
  return 0
}

function vmSnapshotting(policy: Policy, vm: VmBackend): Snapshotting {
  return { ...snapshotting(policy), take: () => vm.snapshot() }
}


/**
 * A VM booted from an older build (scripts/vm/build.sh ran since) lacks whatever changed in L1/L2.
 * Checkpoint its guest as a step — background processes may have moved on since the last one — stop
 * it, and boot the current build at that checkpoint. Snapshots are on the host, so nothing is lost.
 */
async function restartIfStale(policy: Policy, opts: { up?: boolean } = {}): Promise<boolean> {
  const workdir = process.cwd()
  if (!(await vmStale(workdir))) return false
  const busy = await busyHolder(ROOT)
  if (busy !== undefined) throw new Error(`vm: the running VM is from an older build, but a step is running (pid ${busy}); retry when it finishes`)
  const t0 = Date.now()
  const session = await currentVmSession()
  const status = await new VmClient(vmPaths(workdir).socket).call({ op: 'status' }).catch(() => undefined)
  let at: SnapshotId | undefined
  if (session && session.meta.vmImage !== (await vmImageStamp())) {
    // The checkpoint could not restore onto the new disks; stop, and let `vm up` start a new session.
    await vmDown(workdir)
    if (opts.up) return false
    throw new Error(`vm: the L2 images were rebuilt since session ${session.meta.id} began, so it cannot continue on them; run \`envgit vm up\` for a new session`)
  }
  if (session && status?.msg.current) at = (await checkpointVm(policy, session, 'before restarting the VM on a new build')).snapshot
  await vmDown(workdir)
  if (!session || !at) {
    console.error('envgit: stopped a VM from an older build')
    return true
  }
  await vmUp(workdir)
  const vm = new VmBackend()
  await vm.create({ workdir })
  await vm.restore(at)
  reportMirror(await vm.syncMirror())
  console.error(`envgit: restarted the VM on the current build in ${((Date.now() - t0) / 1000).toFixed(1)}s, resumed at a checkpoint of session ${session.meta.id}`)
  return true
}

/** Records the running guest as a `ckpt` step: what background processes did since the last step. */
async function checkpointVm(policy: Policy, session: OpenSession, reason: string) {
  const vm = new VmBackend()
  await vm.create({ workdir: process.cwd() })
  await acquireBusy(ROOT)
  try {
    const now = new Date().toISOString()
    const { step } = await recordVmStep(session, snapshotting(policy), vm, { startedAt: now, endedAt: now, action: { type: 'checkpoint', input: reason }, exitCode: 0, effects: [] })
    return step
  } finally {
    await releaseBusy(ROOT)
  }
}

async function currentVmSession(): Promise<OpenSession | undefined> {
  if (!(await exists(join(ROOT, 'current')))) return undefined
  const session = await openSession(ROOT, 'vm')
  return session.meta.backend === 'vm' && session.meta.base ? session : undefined
}

async function vmClientAlive(workdir: string): Promise<boolean> {
  return new VmClient(vmPaths(workdir).socket).alive()
}

/** The current vm session, with the VM on the current build (see restartIfStale). */
async function vmSession(policy: Policy): Promise<OpenSession> {
  if (!(await exists(join(ROOT, 'current')))) throw new Error('no vm session here — run `envgit vm up`')
  const session = await openSession(ROOT, 'vm')
  if (session.meta.backend !== 'vm') throw new Error('the current session is not a vm session — run `envgit vm up`')
  await restartIfStale(policy)
  return session
}

/**
 * L2's only way out is the proxy tunnel, served for the length of this step when the policy allows
 * any host: srt's proxy with the allowlist and the same gate as on srt. Shell rules were checked by the caller.
 */
async function runVm(argv: string[], policy: Policy, gate: Gate, shellIrreversible?: string): Promise<number> {
  const session = await vmSession(policy)
  const vm = new VmBackend()
  const env = await vm.create({ workdir: process.cwd() })
  await acquireBusy(ROOT)
  try {
    const started = new Date()
    const net = policy.network?.allow?.length ? L2_NET_ENV : undefined
    const { result, effects: netEffects } = await withEgress(process.cwd(), policy, gate, vm, () => vm.exec(env, { argv, env: net }))
    const effects = [...result.effects, ...netEffects]
    reportEffects(effects)
    const irreversible = shellIrreversible ?? irreversibleOf(effects)
    const { step, mirror: m } = await recordVmStep(session, snapshotting(policy), vm, {
      startedAt: started.toISOString(),
      endedAt: new Date().toISOString(),
      action: { type: 'exec', input: JSON.stringify(argv) },
      exitCode: result.exitCode,
      effects,
      ...(irreversible && { irreversible: { reason: irreversible } }),
    })
    console.error(`envgit: step ${step.index} recorded in vm session ${session.meta.id}${m.written || m.removed ? ` (mirror: ${m.written} written, ${m.removed} removed)` : ''}`)
    return result.exitCode
  } finally {
    await releaseBusy(ROOT)
  }
}

async function vmCmd(args: string[]): Promise<number> {
  const policy = await requireInit()
  const workdir = process.cwd()
  switch (args[0]) {
    case 'up': {
      const t0 = Date.now()
      if (!args.includes('--new') && (await restartIfStale(policy, { up: true })) && (await vmClientAlive(workdir))) return 0
      const current = args.includes('--new') ? undefined : await currentVmSession()
      const resumeAt = current && (await snapshotOf(current, await readHead(current.dir)))
      if (args.includes('--new') && (await vmStale(workdir))) await vmDown(workdir)
      if (!(await vmUp(workdir))) {
        console.error('envgit: vm is already running here')
        return 0
      }
      const vm = new VmBackend()
      await vm.create({ workdir })
      const sameImage = current?.meta.vmImage === (await vmImageStamp())
      if (current && resumeAt && sameImage && (await vmSnapshotExists(workdir, resumeAt))) {
        const head = await readHead(current.dir)
        await vm.restore(resumeAt)
        reportMirror(await vm.syncMirror())
        console.error(`envgit: vm up in ${((Date.now() - t0) / 1000).toFixed(1)}s, resumed session ${current.meta.id} at ${head === 'base' ? 'base' : `step ${head}`}`)
        return 0
      }
      if (current && !sameImage) console.error(`envgit: session ${current.meta.id} was taken on other L2 images (rebuilt since); its snapshots cannot restore onto these, so starting a new session — it stays in the log`)
      else if (current) console.error(`envgit: session ${current.meta.id} has no snapshot on disk to resume (it predates host-side snapshots); starting a new one`)
      await vm.boot()
      await vm.importTar(await tarFrom(workdir, ['.'], policy.snapshot?.exclude ?? []))
      const session = await createSession(ROOT, 'vm')
      session.meta.vmImage = await vmImageStamp()
      await writeMeta(session)
      await ensureBase(session, vmSnapshotting(policy, vm))
      // A manifest from an earlier session would make the first sync delete what this import left out.
      await rm(join(ROOT, 'vm', 'mirror.json'), { force: true })
      await vm.syncMirror()
      console.error(`envgit: vm up in ${((Date.now() - t0) / 1000).toFixed(1)}s, session ${session.meta.id}; the workdir is now a read-only mirror of the VM's /work`)
      return 0
    }
    case 'down': {
      // Keep what the guest did since the last step (background processes run on): checkpoint it first,
      // when the session can resume from it at all (same L2 images, a guest running).
      let ckpt = ''
      if (await vmClientAlive(workdir)) {
        const busy = await busyHolder(ROOT)
        if (busy !== undefined) throw new Error(`vm: a step is running here (pid ${busy}); wait for it to finish, then stop the VM`)
        const session = await currentVmSession()
        const status = await new VmClient(vmPaths(workdir).socket).call({ op: 'status' }).catch(() => undefined)
        if (session && status?.msg.current && session.meta.vmImage === (await vmImageStamp())) {
          ckpt = ` at checkpoint step ${(await checkpointVm(policy, session, 'before vm down')).index}`
        }
      }
      console.error((await vmDown(workdir)) ? `envgit: vm stopped${ckpt}; its snapshots stay in .envgit/vm/snaps and \`envgit vm up\` resumes the session` : 'envgit: vm was not running')
      return 0
    }
    case 'status': {
      const client = new VmClient(vmPaths(workdir).socket)
      if (!(await client.alive())) {
        console.log('vm: not running')
        return 1
      }
      const { msg } = await client.call({ op: 'status' })
      console.log(msg.current ? `vm: running, base ${msg.base}, current ${msg.current}` : 'vm: running, no guest')
      return 0
    }
    case 'prebuild':
      // Used by scripts/vm/build.sh, in a throwaway workdir: the base snapshot new sessions restore.
      if (!args[1]) throw new Error('usage: envgit vm prebuild <out-dir>')
      await buildPrebuiltBase(workdir, resolve(args[1]))
      return 0
    case 'push': {
      const paths = args.slice(1)
      if (!paths.length) throw new Error('usage: envgit vm push <path...>')
      const session = await vmSession(policy)
      const vm = new VmBackend()
      await vm.create({ workdir })
      await acquireBusy(ROOT)
      try {
        const startedAt = new Date().toISOString()
        await vm.importTar(await tarFrom(workdir, paths))
        const { step } = await recordVmStep(session, snapshotting(policy), vm, {
          startedAt,
          endedAt: new Date().toISOString(),
          action: { type: 'push', input: JSON.stringify(paths) },
          exitCode: 0,
          effects: [],
        })
        console.error(`envgit: pushed ${paths.length} path(s) as step ${step.index}`)
        return 0
      } finally {
        await releaseBusy(ROOT)
      }
    }
    default:
      throw new Error('usage: envgit vm up|down|status|push <path...>')
  }
}

let code: number
try {
  switch (cmd) {
    case 'init':
      code = await init()
      break
    case 'run':
      code = await run(args)
      break
    case 'log':
      code = await log()
      break
    case 'ui':
      code = await ui(args)
      break
    case 'rewind':
      code = await rewind(args)
      break
    case 'fork':
      code = await fork(args)
      break
    case 'session':
      code = await sessionCmd(args)
      break
    case 'gc':
      code = await gc()
      break
    case 'vm':
      code = await vmCmd(args)
      break
    case 'codex':
      code = await codex(args)
      break
    case 'codex-exec-server':
      code = await codexExecServer()
      break
    case 'codex-http-helper':
      code = await httpHelper()
      break
    case 'claude':
      code = await claude(args)
      break
    case 'hooks':
      code = await hooksCmd(args)
      break
    case 'hook':
      code = await hook(args)
      break
    case 'mcp':
      if (args[0] === '--worker') {
        await runWorker()
        code = 0
      } else {
        code = await mcp(args[0] === '--tools' ? 'tools' : 'repl')
      }
      break
    default:
      console.log(help)
      code = 0
  }
} catch (e) {
  console.error(`envgit: ${e instanceof Error ? e.message : String(e)}`)
  code = 1
}
process.exit(code)
