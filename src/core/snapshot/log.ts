/** Append-only action log. See docs/design.md §2 */
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Effect, SnapshotId } from '../env/backend.js'

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
}

export async function openSession(root: string, backend: string): Promise<{ dir: string; meta: SessionMeta }> {
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
