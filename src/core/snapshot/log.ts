/** Append-only action log. See docs/design.md §2 */
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Effect, SnapshotId } from '../env/backend.js'
import type { SnapshotStore } from './store.js'

export interface Step {
  index: number
  startedAt: string
  endedAt: string
  action: { type: 'exec' | 'repl'; input: string }
  exitCode: number
  effects: Effect[]
  irreversible?: { reason: string }
  snapshot?: SnapshotId
  parent?: number
}

export interface Session {
  id: string
  createdAt: string
  steps: Step[]
}

export interface SessionMeta {
  id: string
  createdAt: string
  backend: string
  /** Workdir state before the first step. */
  base?: SnapshotId
  forkedFrom?: { session: string; step: number | 'base'; snapshot: SnapshotId }
}

export async function openSession(root: string, backend: string): Promise<OpenSession> {
  const currentFile = join(root, 'current')
  const current = await readFile(currentFile, 'utf8').then(s => s.trim(), () => '')
  if (current) {
    const dir = join(root, 'sessions', current)
    const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as SessionMeta
    return { dir, meta }
  }
  const createdAt = new Date().toISOString()
  const meta: SessionMeta = { id: `${createdAt.replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`, createdAt, backend }
  const dir = join(root, 'sessions', meta.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.json'), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
  await writeFile(currentFile, meta.id + '\n')
  return { dir, meta }
}

export async function readSteps(sessionDir: string): Promise<Step[]> {
  const text = await readFile(join(sessionDir, 'steps.jsonl'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return ''
    throw e
  })
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as Step)
}

export async function nextStepIndex(sessionDir: string): Promise<number> {
  return (await readSteps(sessionDir)).length
}

export async function appendStep(sessionDir: string, step: Step): Promise<void> {
  await appendFile(join(sessionDir, 'steps.jsonl'), JSON.stringify(step) + '\n')
}

export type StepRef = number | 'base'

export interface OpenSession {
  dir: string
  meta: SessionMeta
}

export async function writeMeta(session: OpenSession): Promise<void> {
  await writeFile(join(session.dir, 'session.json'), JSON.stringify(session.meta, null, 2) + '\n')
}

/** The step the workdir currently descends from. Steps off this chain stay in the log. */
export async function readHead(sessionDir: string): Promise<StepRef> {
  const text = await readFile(join(sessionDir, 'head'), 'utf8').then(s => s.trim(), () => '')
  if (text) return text === 'base' ? 'base' : Number(text)
  const steps = await readSteps(sessionDir)
  return steps.length ? steps.length - 1 : 'base'
}

export async function writeHead(sessionDir: string, head: StepRef): Promise<void> {
  await writeFile(join(sessionDir, 'head'), `${head}\n`)
}

/** Steps from the first one to `head`, following `parent`. */
export function activeChain(steps: Step[], head: StepRef): Step[] {
  const chain: Step[] = []
  for (let i: number | undefined = head === 'base' ? undefined : head; i !== undefined; i = steps[i]?.parent) {
    const s = steps[i]
    if (!s) break
    chain.unshift(s)
  }
  return chain
}

export async function snapshotOf(session: OpenSession, ref: StepRef): Promise<SnapshotId | undefined> {
  if (ref === 'base') return session.meta.base
  return (await readSteps(session.dir))[ref]?.snapshot
}

export interface Snapshotting {
  store: SnapshotStore
  workdir: string
  exclude: string[]
}

/** Takes the base snapshot if the session has none yet. Call before running the first step. */
export async function ensureBase(session: OpenSession, snap: Snapshotting): Promise<void> {
  if (session.meta.base) return
  session.meta.base = await snap.store.snapshot(snap.workdir, snap.exclude)
  await writeMeta(session)
}

/** Snapshots the workdir and appends a step as a child of the current head. */
export async function recordStep(
  session: OpenSession,
  snap: Snapshotting,
  partial: Omit<Step, 'index' | 'parent' | 'snapshot'>,
): Promise<Step> {
  const steps = await readSteps(session.dir)
  const head = await readHead(session.dir)
  const prevId = await snapshotOf(session, head)
  const prev = prevId && (await snap.store.has(prevId)) ? await snap.store.read(prevId) : undefined
  const snapshot = await snap.store.snapshot(snap.workdir, snap.exclude, prev)
  const step: Step = { ...partial, index: steps.length, ...(head !== 'base' && { parent: head }), snapshot }
  await appendStep(session.dir, step)
  await writeHead(session.dir, step.index)
  return step
}
