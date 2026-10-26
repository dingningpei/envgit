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

export type Manifest = Entry[]

/** Always excluded: envgit's own state. */
const ALWAYS_EXCLUDED = ['.envgit']

export class SnapshotStore {
  constructor(readonly root: string) {}

  private objects = () => join(this.root, 'objects')
  private manifests = () => join(this.root, 'snapshots')

  async read(id: SnapshotId): Promise<Manifest> {
    return JSON.parse(await readFile(join(this.manifests(), `${id}.json`), 'utf8')) as Manifest
  }

  async has(id: SnapshotId): Promise<boolean> {
    return lstat(join(this.manifests(), `${id}.json`)).then(() => true, () => false)
  }

  /**
   * Snapshots `workdir`. Files whose size, mtime and mode match `prev` reuse its hash without being
   * read, so an unchanged tree costs one stat per entry.
   */
  async snapshot(workdir: string, exclude: string[] = [], prev?: Manifest): Promise<SnapshotId> {
    const known = new Map(prev?.flatMap(e => (e.kind === 'file' ? [[e.path, e] as const] : [])))
    const manifest: Manifest = []
    await mkdir(this.objects(), { recursive: true })
    for (const { path, stat } of await scan(workdir, exclude)) {
      if (stat.isDirectory()) {
        manifest.push({ path, kind: 'dir', mode: stat.mode & 0o7777 })
      } else if (stat.isSymbolicLink()) {
        manifest.push({ path, kind: 'symlink', target: await readlink(join(workdir, path)) })
      } else if (stat.isFile()) {
        const mode = stat.mode & 0o7777
        const old = known.get(path)
        const hash =
          old && old.size === stat.size && old.mtimeMs === stat.mtimeMs && old.mode === mode
            ? old.hash
            : await this.putBlob(join(workdir, path))
        manifest.push({ path, kind: 'file', mode, size: stat.size, mtimeMs: stat.mtimeMs, hash })
      }
    }
    // The id covers content only; sizes and mtimes are kept as a cache for the next snapshot.
    const id = createHash('sha256').update(manifest.map(contentKey).join('\n')).digest('hex') as SnapshotId
    const body = JSON.stringify(manifest)
    await mkdir(this.manifests(), { recursive: true })
    await writeFile(join(this.manifests(), `${id}.json`), body, { flag: 'wx' }).catch(ignoreExists)
    return id
  }

  /** Makes `workdir` match snapshot `id`, touching only entries that differ. Not atomic. */
  async restore(workdir: string, id: SnapshotId, exclude: string[] = []): Promise<void> {
    const target = await this.read(id)
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
        if (cur && cur.size === e.size && cur.mtimeMs === e.mtimeMs && (cur.mode & 0o7777) === e.mode) continue
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
    for (const e of manifest) {
      if (e.kind !== 'file') continue
      await copyFile(this.blob(e.hash), other.blob(e.hash), constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL).catch(ignoreExists)
    }
    await mkdir(other.manifests(), { recursive: true })
    await writeFile(join(other.manifests(), `${id}.json`), JSON.stringify(manifest), { flag: 'wx' }).catch(ignoreExists)
  }

  private blob(hash: string): string {
    return join(this.objects(), hash)
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

function contentKey(e: Entry): string {
  return JSON.stringify(e.kind === 'file' ? [e.path, 'f', e.mode, e.hash] : e.kind === 'dir' ? [e.path, 'd', e.mode] : [e.path, 'l', e.target])
}

/** Entries under `workdir` in sorted, parent-before-child order. Never follows symlinks. */
async function scan(workdir: string, exclude: string[]) {
  const skip = [...ALWAYS_EXCLUDED, ...exclude].map(p => p.replace(/^\.\/|\/$/g, ''))
  const out: { path: string; stat: Stats }[] = []
  const walk = async (rel: string) => {
    const names = (await readdir(join(workdir, rel))).sort()
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name
      if (skip.some(s => path === s || path.startsWith(`${s}/`))) continue
      const stat = await lstat(join(workdir, path))
      out.push({ path, stat })
      if (stat.isDirectory()) await walk(path)
    }
  }
  await walk('')
  return out
}

function hashFile(abs: string): Promise<string> {
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

