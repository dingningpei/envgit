/** Content-addressed workdir snapshots for backends without native ones (srt). See docs/design.md §2 */
import { createHash } from 'node:crypto'
import { constants, createReadStream, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SnapshotId } from '../env/backend.js'

export type Entry =
  | { path: string; kind: 'dir'; mode: number }
  | { path: string; kind: 'file'; mode: number; size: number; mtimeMs: number; hash: string }
  | { path: string; kind: 'symlink'; target: string }

export interface Manifest {
  /** When the snapshot was taken. Cached hashes are trusted only for files older than this. */
  at: number
  entries: Entry[]
}

/**
 * A file modified this close to a snapshot may change again without its size or mtime moving
 * (git's "racy" case), so its cached hash is not trusted.
 */
const RACY_MS = 2000

/** Always excluded: envgit's own state. */
const ALWAYS_EXCLUDED = ['.envgit']

export class SnapshotStore {
  constructor(readonly root: string) {}

  private objects = () => join(this.root, 'objects')
  private manifests = () => join(this.root, 'snapshots')

  async read(id: SnapshotId): Promise<Manifest> {
    const raw = JSON.parse(await readFile(join(this.manifests(), `${id}.json`), 'utf8')) as Manifest | Entry[]
    // Pre-`at` manifests were bare arrays; trust none of their cached hashes.
    return Array.isArray(raw) ? { at: 0, entries: raw } : raw
  }

  async has(id: SnapshotId): Promise<boolean> {
    return lstat(join(this.manifests(), `${id}.json`)).then(() => true, () => false)
  }

  /**
   * Snapshots `workdir`. Files whose size, mtime and mode match `prev` (and are older than it by
   * RACY_MS) reuse its hash without being read, so an unchanged tree costs one stat per entry.
   * With `persist: false` nothing is written; only the id is computed.
   */
  async snapshot(workdir: string, exclude: string[] = [], prev?: Manifest, { persist = true } = {}): Promise<SnapshotId> {
    const at = Date.now()
    const known = new Map(prev?.entries.flatMap(e => (e.kind === 'file' ? [[e.path, e] as const] : [])))
    const entries: Entry[] = []
    if (persist) await mkdir(this.objects(), { recursive: true })
    for (const { path, stat } of await scan(workdir, exclude)) {
      if (stat.isDirectory()) {
        entries.push({ path, kind: 'dir', mode: stat.mode & 0o7777 })
      } else if (stat.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', target: await readlink(join(workdir, path)) })
      } else {
        const mode = stat.mode & 0o7777
        const old = known.get(path)
        const cached = old && prev && old.size === stat.size && old.mtimeMs === stat.mtimeMs && old.mode === mode && old.mtimeMs < prev.at - RACY_MS
        const abs = join(workdir, path)
        const hash = cached ? old.hash : persist ? await this.putBlob(abs) : await hashFile(abs)
        entries.push({ path, kind: 'file', mode, size: stat.size, mtimeMs: stat.mtimeMs, hash })
      }
    }
    const id = manifestId(entries)
    if (persist) {
      await mkdir(this.manifests(), { recursive: true })
      await writeFile(join(this.manifests(), `${id}.json`), JSON.stringify({ at, entries } satisfies Manifest), { flag: 'wx' }).catch(ignoreExists)
    }
    return id
  }

  /** Makes `workdir` match snapshot `id`, touching only entries that differ. Not atomic. */
  async restore(workdir: string, id: SnapshotId, exclude: string[] = []): Promise<void> {
    const { at, entries: target } = await this.read(id)
    const want = new Map(target.map(e => [e.path, e]))
    const have = new Map((await scan(workdir, exclude)).map(e => [e.path, e.stat]))

    // Remove what should not be there, deepest first so directories are empty when reached.
    for (const [path, stat] of [...have].reverse()) {
      const w = want.get(path)
      const sameKind = w && (w.kind === 'dir' ? stat.isDirectory() : w.kind === 'symlink' ? stat.isSymbolicLink() : stat.isFile())
      if (!sameKind) await rm(join(workdir, path), { recursive: true, force: true })
    }

    const fresh = new Map((await scan(workdir, exclude)).map(e => [e.path, e.stat]))
    const dirs: Extract<Entry, { kind: 'dir' }>[] = []
    for (const e of target) {
      const abs = join(workdir, e.path)
      const cur = fresh.get(e.path)
      if (e.kind === 'dir') {
        if (!cur) await mkdir(abs, { recursive: true })
        dirs.push(e)
      } else if (e.kind === 'symlink') {
        if (cur && (await readlink(abs)) === e.target) continue
        await rm(abs, { force: true })
        await symlink(e.target, abs)
      } else {
        if (cur && cur.size === e.size && cur.mtimeMs === e.mtimeMs && (cur.mode & 0o7777) === e.mode && e.mtimeMs < at - RACY_MS) continue
        if (!(cur && cur.size === e.size && (await hashFile(abs)) === e.hash)) {
          await mkdir(dirname(abs), { recursive: true })
          await rm(abs, { force: true })
          await copyFile(this.blob(e.hash), abs, constants.COPYFILE_FICLONE)
        }
        await chmod(abs, e.mode)
        // Restoring mtime keeps the next snapshot of an untouched tree identical to this one.
        await utimes(abs, new Date(), new Date(e.mtimeMs))
      }
    }
    // Directory modes last, deepest first, so a read-only dir does not block writes inside it.
    for (const d of dirs.reverse()) await chmod(join(workdir, d.path), d.mode)
  }

  /** Copies the blobs and manifest of `id` into another store (for fork). */
  async copyTo(other: SnapshotStore, id: SnapshotId): Promise<void> {
    const manifest = await this.read(id)
    await mkdir(other.objects(), { recursive: true })
    for (const e of manifest.entries) {
      if (e.kind !== 'file') continue
      await copyFile(this.blob(e.hash), other.blob(e.hash), constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL).catch(ignoreExists)
    }
    await mkdir(other.manifests(), { recursive: true })
    await writeFile(join(other.manifests(), `${id}.json`), JSON.stringify(manifest), { flag: 'wx' }).catch(ignoreExists)
  }

  /**
   * Deletes manifests not in `live` and blobs no remaining manifest uses. Anything younger than
   * `graceMs` is kept: blobs are written before their manifest, so a snapshot in progress in another
   * process would otherwise lose them.
   */
  async gc(live: Set<SnapshotId>, graceMs = 3600_000): Promise<{ snapshots: number; blobs: number; tmp: number; bytes: number }> {
    const cutoff = Date.now() - graceMs
    const removed = { snapshots: 0, blobs: 0, tmp: 0, bytes: 0 }
    const used = new Set<string>()
    for (const name of await readdir(this.manifests()).catch(() => [] as string[])) {
      const id = name.replace(/\.json$/, '') as SnapshotId
      const path = join(this.manifests(), name)
      if (live.has(id) || (await lstat(path)).ctimeMs > cutoff) {
        for (const e of (await this.read(id)).entries) if (e.kind === 'file') used.add(e.hash)
      } else {
        await rm(path)
        removed.snapshots++
      }
    }
    for (const name of await readdir(this.objects()).catch(() => [] as string[])) {
      if (used.has(name)) continue
      const path = join(this.objects(), name)
      const st = await lstat(path)
      // ctime, not mtime: a cloned blob keeps the source file's mtime.
      if (st.ctimeMs > cutoff) continue
      await rm(path, { force: true })
      // `.tmp` files are blobs whose writer crashed before renaming them into place.
      if (name.endsWith('.tmp')) removed.tmp++
      else removed.blobs++
      removed.bytes += st.size
    }
    return removed
  }

  private blob(hash: string): string {
    return join(this.objects(), hash)
  }

  /** Paths whose entry differs between two snapshots (`before` undefined: everything in `after` is new). */
  async changes(before: SnapshotId | undefined, after: SnapshotId): Promise<{ path: string; op: 'write' | 'delete'; kind: Entry['kind'] }[]> {
    const prev = new Map(before && (await this.has(before)) ? (await this.read(before)).entries.map(e => [e.path, e]) : [])
    const next = new Map((await this.read(after)).entries.map(e => [e.path, e]))
    const same = (a: Entry, b: Entry) =>
      a.kind === b.kind && (a.kind === 'file' ? a.hash === (b as typeof a).hash && a.mode === (b as typeof a).mode : a.kind === 'symlink' ? a.target === (b as typeof a).target : true)
    const out: { path: string; op: 'write' | 'delete'; kind: Entry['kind'] }[] = []
    for (const [path, e] of next) if (!prev.has(path) || !same(prev.get(path)!, e)) out.push({ path, op: 'write', kind: e.kind })
    for (const [path, e] of prev) if (!next.has(path)) out.push({ path, op: 'delete', kind: e.kind })
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** A file's contents as stored, by its manifest hash. */
  async readBlob(hash: string): Promise<Buffer> {
    if (!/^[0-9a-f]+$/.test(hash)) throw new Error(`not a blob hash: ${hash}`)
    return readFile(this.blob(hash))
  }

  private async putBlob(abs: string): Promise<string> {
    const hash = await hashFile(abs)
    const dst = this.blob(hash)
    if (await lstat(dst).then(() => true, () => false)) return hash
    const tmp = `${dst}.${process.pid}.tmp`
    await copyFile(abs, tmp, constants.COPYFILE_FICLONE)
    await chmod(tmp, 0o444)
    await rename(tmp, dst)
    return hash
  }
}

/** The id covers content only; `at`, sizes and mtimes are a cache for the next snapshot. */
export function manifestId(entries: Entry[]): SnapshotId {
  return createHash('sha256').update(entries.map(contentKey).join('\n')).digest('hex') as SnapshotId
}

function contentKey(e: Entry): string {
  return JSON.stringify(e.kind === 'file' ? [e.path, 'f', e.mode, e.hash] : e.kind === 'dir' ? [e.path, 'd', e.mode] : [e.path, 'l', e.target])
}

/**
 * Dirs, regular files and symlinks under `workdir` in sorted, parent-before-child order. Never
 * follows symlinks. FIFOs, sockets and devices are invisible: never snapshotted, never removed.
 */
async function scan(workdir: string, exclude: string[]) {
  const skip = [...ALWAYS_EXCLUDED, ...exclude].map(p => p.replace(/^\.\/|\/$/g, ''))
  const out: { path: string; stat: Stats }[] = []
  const walk = async (rel: string) => {
    const names = (await readdir(join(workdir, rel))).sort()
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name
      if (skip.some(s => path === s || path.startsWith(`${s}/`))) continue
      const stat = await lstat(join(workdir, path))
      if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) continue
      out.push({ path, stat })
      if (stat.isDirectory()) await walk(path)
    }
  }
  await walk('')
  return out
}

export function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(abs)
      .on('data', d => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function ignoreExists(e: NodeJS.ErrnoException) {
  if (e.code !== 'EEXIST') throw e
}

