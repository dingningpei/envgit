/**
 * snapshot.maxBytes: keeps a workdir's snapshots under a size by dropping rewind points, oldest
 * history first (docs/design.md §3.5). Steps keep their log entries; only their snapshots go, recorded
 * in the session's `pruned` list. Runs after each recorded step (under the busy lock) and from `envgit gc`.
 *
 * Order: snapshots nothing refers to; then whole older sessions; then the current session's
 * abandoned branches; then its current branch from the oldest step on, keeping base, head and the
 * last KEEP_RECENT steps. On vm a step's memory is a diff on its parent's, so dropping one on the
 * current branch folds it into its children first (foldVmDiff).
 */
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { foldVmDiff, gcVmSnapshots, vmPaths, vmSnapshotBytes } from '../env/vm.js'
import { activeChain, addPruned, liveSnapshots, readHead, readPruned, readSteps, type SessionMeta, type Step, type StepRef } from './log.js'
import type { SnapshotStore } from './store.js'

/** Steps at the end of the current branch that are never pruned. */
export const KEEP_RECENT = 10
/** Below the cap, measure at most this often: walking the store costs a stat per blob. */
const MEASURE_EVERY_MS = 60_000

export interface CapOptions {
  root: string
  workdir: string
  maxBytes: number
  store: SnapshotStore
  log?: (line: string) => void
}

export interface CapResult {
  before: number
  after: number
  pruned: { session: string; steps: StepRef[] }[]
}

/** `500M`, `10G`, `1.5GB`, or a number of bytes. */
export function parseBytes(v: number | string): number {
  if (typeof v === 'number') return v
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(v)
  if (!m) throw new Error(`snapshot.maxBytes: cannot read ${JSON.stringify(v)} as a size (e.g. 500M, 10G)`)
  return Math.round(Number(m[1]) * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()))
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) n += (await lstat(join(dir, name)).catch(() => ({ size: 0 }))).size
  return n
}

export async function snapshotBytes(root: string, workdir: string): Promise<number> {
  return (await dirBytes(join(root, 'objects'))) + (await dirBytes(join(root, 'snapshots'))) + (await vmSnapshotBytes(workdir))
}

/** Prunes until under the cap; undefined when nothing needed doing (or it was measured recently). */
export async function enforceCap(o: CapOptions, { force = false } = {}): Promise<CapResult | undefined> {
  const stateFile = join(o.root, 'cap-check')
  const last = await readFile(stateFile, 'utf8').then(t => JSON.parse(t) as { at: number; over: boolean }, () => undefined)
  if (!force && last && !last.over && Date.now() - last.at < MEASURE_EVERY_MS) return undefined
  const before = await snapshotBytes(o.root, o.workdir)
  const done = async (over: boolean) => writeFile(stateFile, JSON.stringify({ at: Date.now(), over }))
  if (before <= o.maxBytes) {
    await done(false)
    return undefined
  }
  const pruned: CapResult['pruned'] = []
  let usage = before
  // Under the busy lock nothing else is writing a snapshot here, so no grace period is needed.
  const collect = async () => {
    const live = await liveSnapshots(o.root)
    await o.store.gc(live, 0)
    await gcVmSnapshots(o.workdir, live)
    usage = await snapshotBytes(o.root, o.workdir)
    return usage <= o.maxBytes
  }
  const prune = async (session: string, steps: StepRef[]) => {
    if (!steps.length) return
    await addPruned(join(o.root, 'sessions', session), steps)
    const hit = pruned.find(p => p.session === session)
    if (hit) hit.steps.push(...steps)
    else pruned.push({ session, steps: [...steps] })
  }
  const finish = async () => {
    await done(usage > o.maxBytes)
    const r = { before, after: usage, pruned }
    if (pruned.length) o.log?.(describe(r, o.maxBytes))
    return r
  }

  if (await collect()) return finish()

  const current = await readFile(join(o.root, 'current'), 'utf8').then(s => s.trim(), () => '')
  const ids = (await readdir(join(o.root, 'sessions')).catch(() => [] as string[])).sort()
  // Older sessions: their logs stay for audit, their rewind points go.
  for (const id of ids) {
    if (id === current) continue
    const dir = join(o.root, 'sessions', id)
    const gone = await readPruned(dir)
    const refs: StepRef[] = [...(await readSteps(dir)).filter(s => s.snapshot && !gone.has(s.index)).map(s => s.index), ...(gone.has('base') ? [] : ['base' as const])]
    await prune(id, refs)
    if (refs.length && (await collect())) return finish()
  }
  if (!current) return finish()

  const dir = join(o.root, 'sessions', current)
  const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as SessionMeta
  const steps = await readSteps(dir)
  const head = await readHead(dir)
  const onChain = new Set(activeChain(steps, head).map(s => s.index))
  const gone = await readPruned(dir)
  const live = (s: Step) => s.snapshot && !gone.has(s.index)

  // Abandoned branches, whole subtrees, oldest first.
  const off = steps.filter(s => !onChain.has(s.index) && live(s))
  const children = new Map<number | 'base', Step[]>()
  for (const s of steps) {
    const k = s.parent ?? 'base'
    children.set(k, [...(children.get(k) ?? []), s])
  }
  const subtree = (s: Step): number[] => [s.index, ...(children.get(s.index) ?? []).flatMap(subtree)]
  for (const root of off.filter(s => s.parent === undefined || onChain.has(s.parent))) {
    await prune(current, subtree(root).filter(i => !gone.has(i)))
    if (await collect()) return finish()
  }

  // The current branch, oldest first, keeping head and the last KEEP_RECENT.
  const chain = activeChain(steps, head).filter(live)
  const eligible = chain.slice(0, Math.max(0, chain.length - KEEP_RECENT)).filter(s => s.index !== head)
  if (meta.backend === 'vm') {
    const snaps = vmPaths(o.workdir).snaps
    for (const s of eligible) {
      // Fold this diff into every snapshot built on it; then nothing needs it.
      for (const name of await readdir(snaps).catch(() => [] as string[])) {
        if (name.startsWith('.')) continue
        const m = await readFile(join(snaps, name, 'meta.json'), 'utf8').then(t => JSON.parse(t) as { parent?: string; kind: string }, () => undefined)
        if (m?.parent === s.snapshot) await foldVmDiff(o.workdir, s.snapshot!, name)
      }
      await prune(current, [s.index])
      if (await collect()) return finish()
    }
  } else {
    // A quarter of what is left at a time: each step frees little, and each measurement walks the store.
    for (let i = 0; i < eligible.length; ) {
      const n = Math.max(1, Math.ceil((eligible.length - i) / 4))
      await prune(current, eligible.slice(i, i + n).map(s => s.index))
      i += n
      if (await collect()) return finish()
    }
  }
  return finish()
}

export function describe(r: CapResult, max: number): string {
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`
  const what = r.pruned.map(p => `session ${p.session}: ${p.steps.length} rewind point(s) (${summarize(p.steps)})`).join('; ')
  const still = r.after > max ? `; still over the cap — base, head and the last ${KEEP_RECENT} steps are kept` : ''
  return `envgit: snapshots ${mb(r.before)} → ${mb(r.after)} under snapshot.maxBytes ${mb(max)}, dropped ${what}${still}`
}

function summarize(steps: StepRef[]): string {
  const nums = steps.filter((s): s is number => s !== 'base').sort((a, b) => a - b)
  const runs: string[] = steps.includes('base') ? ['base'] : []
  for (let i = 0; i < nums.length; ) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++
    runs.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`)
    i = j + 1
  }
  return runs.join(', ')
}
