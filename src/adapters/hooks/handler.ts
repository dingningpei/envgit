/**
 * `envgit hook <agent> <pre|post|stop>`: what Claude Code and Copilot CLI run around each tool call
 * (docs/design.md §3.4). The agent executes the tool itself, in its own sandbox; envgit judges shell
 * commands before they run and records a step — an fs-level snapshot of the workdir — after every
 * call that can change files, plus a checkpoint at the end of a turn for what changed in between.
 *
 * A hook must never wedge the agent: errors go to stderr and the hook exits 0 (a pre hook then allows).
 */
import { relative, isAbsolute } from 'node:path'
import type { Effect, SnapshotId } from '../../core/env/backend.js'
import { irreversibleOf, judgeShell } from '../../core/policy/gate.js'
import type { Policy } from '../../core/policy/schema.js'
import { acquireBusy, ensureBase, openSession, readHead, recordStep, releaseBusy, snapshotOf, type Snapshotting, type Step } from '../../core/snapshot/log.js'
import { changesFiles, normalize, type Agent, type ToolEvent } from './normalize.js'

export type HookEvent = 'pre' | 'post' | 'post-failed' | 'stop'

export interface HookContext {
  root: string
  workdir: string
  policy: Policy
  snapshotting: Snapshotting
  /**
   * When the agent itself runs in envgit's sandbox (`envgit claude`): the requests the gate judged
   * and the sandbox denials since the last step, which go on the step being recorded.
   */
  sandboxEffects?: () => Effect[]
}

/** Per kind, as on vm: a `npm install` must not put tens of thousands of paths in the log. */
const MAX_FS_EFFECTS = 1000
const BUSY_WAIT_MS = 10_000

/** Returns what to print on stdout (the agent reads a pre hook's decision there). */
export async function runHook(agent: Agent, event: HookEvent, input: string, ctx: HookContext): Promise<string> {
  const raw = input.trim() ? (JSON.parse(input) as Record<string, unknown>) : {}
  const ev = normalize(agent, raw)
  if (event === 'pre') return pre(ev, ctx)
  if (event === 'stop') {
    await withBusy(ctx, () => checkpoint(ev, ctx))
    return ''
  }
  if (changesFiles(ev.tool)) await withBusy(ctx, () => post(ev, event === 'post-failed', ctx))
  return ''
}

async function pre(ev: ToolEvent, ctx: HookContext): Promise<string> {
  // The base must be taken before the first tool changes anything.
  if (changesFiles(ev.tool)) {
    await withBusy(ctx, async () => {
      const session = await openSession(ctx.root, 'srt')
      await ensureBase(session, ctx.snapshotting)
    })
  }
  if (!ev.command) return ''
  const hit = judgeShell(ctx.policy, ['sh', '-c', ev.command])
  if (!hit || hit.action === 'allow') return ''
  // `ask` goes to the agent's own approval prompt; envgit has no terminal of its own here.
  const reason =
    hit.action === 'deny'
      ? `envgit: \`${ev.command}\` is irreversible (${hit.rule}) and the policy denies it`
      : `envgit: \`${ev.command}\` is irreversible (${hit.rule}): rewind cannot undo it, so it needs your approval`
  const decision = hit.action === 'deny' ? 'deny' : 'ask'
  return JSON.stringify(
    ev.agent === 'claude-code'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
      : { permissionDecision: decision, permissionDecisionReason: reason },
  )
}

/** Snapshots the workdir and lists what differs from the head step's snapshot. */
async function capture(ctx: HookContext) {
  const session = await openSession(ctx.root, 'srt')
  await ensureBase(session, ctx.snapshotting)
  const { store, workdir, exclude } = ctx.snapshotting
  const prevId = await snapshotOf(session, await readHead(session.dir))
  const prev = prevId && (await store.has(prevId)) ? await store.read(prevId) : undefined
  const id = await store.snapshot(workdir, exclude, prev)
  const changes = (await store.changes(prevId, id)).filter(c => c.kind !== 'dir')
  const effects: Effect[] = [
    ...changes.filter(c => c.op === 'write').slice(0, MAX_FS_EFFECTS).map(c => ({ kind: 'fs', op: 'write', path: c.path }) as const),
    ...changes.filter(c => c.op === 'delete').slice(0, MAX_FS_EFFECTS).map(c => ({ kind: 'fs', op: 'delete', path: c.path }) as const),
  ]
  return { session, id, prevId, effects }
}

async function post(ev: ToolEvent, failed: boolean, ctx: HookContext): Promise<void> {
  const { session, id, effects: files } = await capture(ctx)
  const net = ctx.sandboxEffects?.() ?? []
  const effects = [...files, ...net]
  const hit = ev.command ? judgeShell(ctx.policy, ['sh', '-c', ev.command]) : undefined
  const wentOut = irreversibleOf(net)
  const rel = (p: string) => (isAbsolute(p) ? relative(ctx.workdir, p) : p)
  const action: Step['action'] = ev.command
    ? { type: 'exec', input: JSON.stringify([ev.command]) }
    : { type: 'fs', input: JSON.stringify([...new Set(ev.paths.map(rel))].map(path => ({ op: 'write', path }))) }
  await recordStep(session, { ...ctx.snapshotting, take: async () => id as SnapshotId }, {
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    action,
    exitCode: failed ? 1 : 0,
    effects,
    // It ran: under `ask` someone approved it in the agent; under `allow` the policy marks it.
    ...(hit
      ? { irreversible: { reason: `${hit.rule} (${ev.command}, ${hit.action === 'ask' ? `approved in ${ev.agent}` : 'allowed'})` } }
      : wentOut && { irreversible: { reason: wentOut } }),
    agent: { name: ev.agent, tool: ev.tool, ...(ev.toolUseId && { toolUseId: ev.toolUseId }) },
  })
}

/** At the end of a turn: what changed outside tool calls (background processes), if anything. */
async function checkpoint(ev: ToolEvent, ctx: HookContext): Promise<void> {
  const { session, id, prevId, effects: files } = await capture(ctx)
  const net = ctx.sandboxEffects?.() ?? []
  const effects = [...files, ...net]
  if ((id === prevId || !files.length) && !net.length) return
  const wentOut = irreversibleOf(net)
  await recordStep(session, { ...ctx.snapshotting, take: async () => id as SnapshotId }, {
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    action: { type: 'checkpoint', input: `end of a ${ev.agent} turn: changes made outside its tool calls` },
    exitCode: 0,
    effects,
    ...(wentOut && { irreversible: { reason: wentOut } }),
    agent: { name: ev.agent, tool: 'Stop' },
  })
}

/** Another envgit step may be running (`envgit run` in another terminal): wait for it a little. */
async function withBusy(ctx: HookContext, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    try {
      await acquireBusy(ctx.root)
      break
    } catch (e) {
      if (Date.now() - t0 > BUSY_WAIT_MS) throw e
      await new Promise(r => setTimeout(r, 100))
    }
  }
  try {
    await fn()
  } finally {
    await releaseBusy(ctx.root)
  }
}
