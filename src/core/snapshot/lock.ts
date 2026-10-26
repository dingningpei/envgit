/**
 * `.envgit/busy` is held by a process between running a step and recording it, so a rewind cannot
 * restore files underneath a step that is still writing them.
 */
import { execFileSync } from 'node:child_process'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface LockRecord {
  pid: number
  /** `ps -o lstart` of the holder, so a reused pid is not mistaken for it. */
  started?: string
}

let ownStart: string | undefined

function startTime(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

function own(): LockRecord {
  ownStart ??= startTime(process.pid)
  return { pid: process.pid, started: ownStart }
}

function parse(raw: string): LockRecord | undefined {
  const text = raw.trim()
  if (!text) return undefined
  // Plain-pid files predate the JSON format.
  const rec = text.startsWith('{') ? (JSON.parse(text) as LockRecord) : { pid: Number(text) }
  return rec.pid ? rec : undefined
}

function alive(rec: LockRecord): boolean {
  try {
    process.kill(rec.pid, 0)
  } catch (e) {
    // EPERM: alive, owned by another user.
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false
  }
  if (!rec.started) return true
  const now = startTime(rec.pid)
  return now === undefined || now === rec.started
}

const lockPath = (root: string) => join(root, 'busy')

async function readLock(root: string): Promise<{ raw: string; rec?: LockRecord }> {
  const raw = await readFile(lockPath(root), 'utf8').catch(() => '')
  return { raw, rec: parse(raw) }
}

/** The live pid holding the busy lock, if any. A stale lock (dead or reused pid) counts as free. */
export async function busyHolder(root: string): Promise<number | undefined> {
  const { rec } = await readLock(root)
  return rec && alive(rec) ? rec.pid : undefined
}

export async function acquireBusy(root: string): Promise<void> {
  const body = JSON.stringify(own())
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath(root), body, { flag: 'wx' })
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const { raw, rec } = await readLock(root)
    if (rec?.pid === process.pid) return
    if (rec && alive(rec)) throw new Error(`another envgit process (pid ${rec.pid}) is running a step here`)
    // Stale: move it aside atomically, and only drop it if it is still the record judged stale;
    // otherwise another process took the lock in between, so put it back.
    const aside = `${lockPath(root)}.stale.${process.pid}`
    try {
      await rename(lockPath(root), aside)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      continue
    }
    if ((await readFile(aside, 'utf8').catch(() => '')) !== raw) {
      await rename(aside, lockPath(root)).catch(() => {})
      throw new Error('the busy lock changed while taking over a stale one; retry')
    }
    await rm(aside, { force: true })
  }
  throw new Error('could not take the busy lock; retry')
}

export async function releaseBusy(root: string): Promise<void> {
  const { rec } = await readLock(root)
  if (rec?.pid === process.pid) await rm(lockPath(root), { force: true })
}
