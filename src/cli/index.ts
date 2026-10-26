#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveMcp } from '../adapters/mcp/server.js'
import { SrtBackend } from '../core/env/srt.js'
import { matchIrreversible } from '../core/policy/compile.js'
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
import type { SnapshotId } from '../core/env/backend.js'
import { SnapshotStore } from '../core/snapshot/store.js'
import { ReplSession } from '../repl/session.js'
import { runWorker } from '../repl/worker.js'

const [cmd = 'help', ...args] = process.argv.slice(2)

const help = `envgit — version control for agent execution environments

  envgit init            create .envgit/ and a default policy
  envgit run <cmd...>    run a command in the sandbox, record a step
  envgit mcp [--tools]   serve the sandboxed REPL as an MCP server on stdio
                         (--tools: one MCP tool per capability instead of execute)
  envgit log                     show the steps leading to the current state
  envgit rewind <step|base>      restore the workdir to a step (--force drops unrecorded edits)
  envgit fork <step|base> <dir>  materialize a step into a new directory with its own session
  envgit session [new]           print the current session, or start a new one
  envgit gc                      delete snapshots and blobs no session refers to

Snapshots are fs-level on srt: files only, not memory or processes. Restart
\`envgit mcp\` after a rewind.`

const ROOT = join(process.cwd(), '.envgit')
const POLICY = join(ROOT, 'policy.yaml')
const DEFAULT_POLICY = fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url))
/** srt violation lines worth showing: fs or network with a target, not sysctl/mach noise. */
const RELEVANT_DENIAL = /\b(file|network)-\S+\s+\S/

function snapshotting(policy: Policy): Snapshotting {
  return { store: new SnapshotStore(ROOT), workdir: process.cwd(), exclude: policy.snapshot?.exclude ?? [] }
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
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)
  const irreversible = matchIrreversible(policy, argv)
  if (irreversible) console.error(red(`envgit: irreversible action (${irreversible}) — not gated in M0, logging only`))

  const snap = snapshotting(policy)
  await acquireBusy(ROOT)
  await ensureBase(session, snap)
  const env = await backend.create({ workdir: process.cwd(), policy, snapshots: snap })
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  try {
    const startedAt = new Date().toISOString()
    const result = await backend.exec(env, { argv }, ac.signal)
    const step = await recordStep(session, snap, {
      startedAt,
      endedAt: new Date().toISOString(),
      action: { type: 'exec', input: JSON.stringify(argv) },
      exitCode: result.exitCode,
      effects: result.effects,
      ...(irreversible && { irreversible: { reason: irreversible } }),
    })
    for (const e of result.effects) {
      if (e.kind === 'policy' && RELEVANT_DENIAL.test(e.reason)) console.error(red(`envgit: denied ${e.reason}`))
    }
    console.error(`envgit: step ${step.index} recorded in session ${session.meta.id}`)
    return result.exitCode
  } finally {
    process.off('SIGINT', onSigint)
    await backend.destroy(env)
    await releaseBusy(ROOT)
  }
}

async function mcp(mode: 'repl' | 'tools'): Promise<number> {
  // stdout carries JSON-RPC; keep every diagnostic on stderr.
  console.log = console.error
  const policy = await requireInit()
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)
  const snap = snapshotting(policy)
  const env = await backend.create({ workdir: process.cwd(), policy, snapshots: snap })
  const repl = new ReplSession(backend, env, policy, session, snap)
  try {
    await serveMcp(repl, policy, process.cwd(), mode)
    return 0
  } finally {
    await repl.close()
    await backend.destroy(env)
  }
}

function parseRef(arg: string | undefined): StepRef {
  if (arg === 'base') return 'base'
  if (arg && /^\d+$/.test(arg)) return Number(arg)
  throw new Error(`expected a step number or "base", got ${arg ?? 'nothing'}`)
}

async function requireInit(): Promise<Policy> {
  if (!(await exists(POLICY))) throw new Error('no .envgit/policy.yaml here — run `envgit init` first')
  const policy = await loadPolicy(POLICY)
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
  await snap.store.restore(snap.workdir, snapshot, snap.exclude)
  await writeHead(session.dir, target)
  await rm(RESTORING)
}

/** Finishes a rewind that was interrupted; restore only touches what differs, so redoing it is safe. */
async function recoverRestore(policy: Policy): Promise<void> {
  const text = await readFile(RESTORING, 'utf8').catch(() => '')
  if (!text) return
  const m = JSON.parse(text) as RestoreMarker
  const session: OpenSession = { dir: join(ROOT, 'sessions', m.session), meta: JSON.parse(await readFile(join(ROOT, 'sessions', m.session, 'session.json'), 'utf8')) }
  await restoreTo(session, snapshotting(policy), m.target, m.snapshot)
  console.error(`envgit: finished an interrupted rewind to ${m.target === 'base' ? 'base' : `step ${m.target}`}`)
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
  const short = (id?: string) => (id ? id.slice(0, 8) : '--------')
  const from = session.meta.forkedFrom
  console.log(`session ${session.meta.id}${from ? ` (forked from ${from.session} step ${from.step})` : ''}`)
  console.log(`  base  ${short(session.meta.base)}`)
  for (const st of chain) {
    const input = st.action.type === 'exec' ? (JSON.parse(st.action.input) as string[]).join(' ') : st.action.input.replace(/\s+/g, ' ')
    const denied = st.effects.filter(e => (e.kind === 'policy' ? RELEVANT_DENIAL.test(e.reason) : 'denied' in e && e.denied)).length
    const cols = [
      String(st.index).padStart(5),
      st.startedAt.slice(11, 19),
      st.action.type.padEnd(4),
      `exit ${st.exitCode}`.padEnd(7),
      short(st.snapshot),
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
  if (!targetId) throw new Error(`step ${target} has no snapshot`)

  const busy = await busyHolder(ROOT)
  if (busy !== undefined) {
    console.error(`envgit: a step is running here (pid ${busy}); wait for it to finish`)
    return 1
  }
  const head = await readHead(session.dir)
  const headId = await snapshotOf(session, head)
  if (headId && !force) {
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
  console.error(`envgit: rewound to ${target === 'base' ? 'base' : `step ${target}`} (${undone.length} step(s) undone); restart envgit mcp if it is running`)
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
  if (!id) throw new Error(`step ${target} has no snapshot`)

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
  await requireInit()
  const live = await liveSnapshots(ROOT)
  const r = await new SnapshotStore(ROOT).gc(live)
  // Logical size: with APFS clones the disk space actually freed can be smaller.
  console.log(`removed ${r.snapshots} snapshot(s), ${r.blobs} blob(s), ${r.tmp} leftover temp file(s), ${(r.bytes / 1e6).toFixed(1)} MB; kept ${live.size} snapshot(s) in use`)
  return 0
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
