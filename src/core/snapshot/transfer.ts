/**
 * `envgit export` / `import`: a session as one file, to send with a bug report or a demo and rewind on
 * another machine (docs/design.md §5 M7). The archive is a small `.envgit`: the session's directory,
 * the manifests of every snapshot it can still restore, and their blobs.
 *
 * An archive may come from anyone, so import trusts nothing in it: names are checked before anything is
 * read, every blob against its hash, every manifest against its id, and every entry path for a way out
 * of the workdir (`..`, a path below a symlink) — restore would write wherever a manifest says.
 */
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SnapshotId } from '../env/backend.js'
import { readPruned, readSteps, type SessionMeta, type Step } from './log.js'
import { hashFile, manifestId, SnapshotStore, type Entry, type Manifest } from './store.js'

const run = promisify(execFile)

/** Bumped when the layout changes; import refuses formats it does not know. */
export const EXPORT_FORMAT = 1
const HEADER = 'envgit-export.json'
const SESSION_FILES = ['session.json', 'steps.jsonl', 'head', 'pruned'] as const
const HEX = /^[0-9a-f]{64}$/
const SESSION_ID = /^[\w-]{1,80}$/

export interface ExportHeader {
  format: number
  envgit: string
  session: string
  backend: string
  createdAt: string
}

/** Writes `out` (a .tar.gz) for the session in `root` (a workdir's `.envgit`). */
export async function exportSession(root: string, id: string, out: string, envgit: string): Promise<{ snapshots: number; blobs: number }> {
  const dir = join(root, 'sessions', id)
  const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8').catch(() => {
    throw new Error(`no session ${id} here`)
  })) as SessionMeta
  // A vm snapshot holds the guest's memory and restores only onto the L2 build it was taken on.
  if (meta.backend === 'vm') throw new Error(`session ${id} is a vm session; export takes srt sessions only (vm snapshots restore only onto the same L2 build)`)
  const tmp = await mkdtemp(join(tmpdir(), 'envgit-export-'))
  try {
    const into = join(tmp, 'sessions', id)
    await mkdir(into, { recursive: true })
    for (const f of SESSION_FILES) await copyFile(join(dir, f), join(into, f)).catch(e => (e.code === 'ENOENT' ? undefined : Promise.reject(e)))
    // The policy it ran under, for whoever reads the report; import keeps it next to the session.
    await copyFile(join(root, 'policy.yaml'), join(into, 'policy.yaml')).catch(() => {})
    const pruned = await readPruned(dir)
    const ids = new Set<SnapshotId>()
    if (meta.base && !pruned.has('base')) ids.add(meta.base)
    for (const s of await readSteps(dir)) if (s.snapshot && !pruned.has(s.index)) ids.add(s.snapshot)
    const store = new SnapshotStore(root)
    const copy = new SnapshotStore(tmp)
    for (const sid of ids) await store.copyTo(copy, sid)
    const header: ExportHeader = { format: EXPORT_FORMAT, envgit, session: id, backend: meta.backend, createdAt: new Date().toISOString() }
    await writeFile(join(tmp, HEADER), JSON.stringify(header, null, 2) + '\n')
    await run('tar', ['-czf', out, '-C', tmp, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return { snapshots: ids.size, blobs: (await readdir(join(tmp, 'objects')).catch(() => [])).length }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Unpacks `file` into `root` as a session of its own, which becomes current. */
export async function importSession(root: string, file: string): Promise<{ session: string; head: string; steps: number; header: ExportHeader }> {
  const tmp = await mkdtemp(join(tmpdir(), 'envgit-import-'))
  try {
    await run('tar', ['-xzf', file, '-C', tmp])
    const header = JSON.parse(await readRegular(join(tmp, HEADER), 'not an envgit export: no envgit-export.json')) as ExportHeader
    if (header.format !== EXPORT_FORMAT) throw new Error(`export format ${header.format} is not one this envgit reads (${EXPORT_FORMAT}); it came from envgit ${header.envgit}`)
    if (typeof header.session !== 'string' || !SESSION_ID.test(header.session)) throw new Error(`bad session id in the export: ${JSON.stringify(header.session)}`)
    const id = header.session
    const target = join(root, 'sessions', id)
    if (await exists(target)) throw new Error(`session ${id} already exists here`)

    // Blobs first: each must be what its name says.
    const objects = join(tmp, 'objects')
    const blobs = await readdir(objects).catch(() => [] as string[])
    for (const h of blobs) {
      if (!HEX.test(h) || !(await lstat(join(objects, h))).isFile() || (await hashFile(join(objects, h))) !== h) throw new Error(`corrupt export: object ${h}`)
    }
    const have = new Set(blobs)
    const manifests = new Map<SnapshotId, Manifest>()
    for (const name of await readdir(join(tmp, 'snapshots')).catch(() => [] as string[])) {
      const sid = name.replace(/\.json$/, '') as SnapshotId
      if (!HEX.test(sid) || name !== `${sid}.json`) throw new Error(`corrupt export: snapshot ${name}`)
      const m = JSON.parse(await readRegular(join(tmp, 'snapshots', name), `corrupt export: snapshot ${name}`)) as Manifest
      checkManifest(m, have, sid)
      manifests.set(sid, m)
    }

    const from = join(tmp, 'sessions', id)
    const meta = JSON.parse(await readRegular(join(from, 'session.json'), 'corrupt export: no session.json')) as SessionMeta
    if (meta.id !== id || meta.backend !== 'srt') throw new Error(`corrupt export: session.json is not srt session ${id}`)
    const steps = (await readRegular(join(from, 'steps.jsonl'), '', true)).split('\n').filter(Boolean).map(l => JSON.parse(l) as Step)
    steps.forEach((s, i) => {
      if (s.index !== i || (s.parent !== undefined && !(Number.isInteger(s.parent) && s.parent >= 0 && s.parent < i))) throw new Error(`corrupt export: step ${i}`)
    })
    const pruned = new Set(JSON.parse((await readRegular(join(from, 'pruned'), '', true)) || '[]') as unknown[])
    for (const [i, sid] of [['base', meta.base] as const, ...steps.map(s => [s.index, s.snapshot] as const)]) {
      if (sid && !pruned.has(i) && !manifests.has(sid)) throw new Error(`corrupt export: ${i === 'base' ? 'base' : `step ${i}`} refers to snapshot ${sid}, which it does not hold`)
    }
    const head = (await readRegular(join(from, 'head'), '', true)).trim() || (steps.length ? String(steps.length - 1) : 'base')
    if (head !== 'base' && !(/^\d+$/.test(head) && Number(head) < steps.length)) throw new Error(`corrupt export: head ${head}`)

    // All checked: copy into place. Blobs and manifests are content-addressed, so existing ones stay.
    const store = new SnapshotStore(root)
    const incoming = new SnapshotStore(tmp)
    for (const sid of manifests.keys()) await incoming.copyTo(store, sid)
    await mkdir(target, { recursive: true })
    for (const f of [...SESSION_FILES, 'policy.yaml']) await copyFile(join(from, f), join(target, f)).catch(e => (e.code === 'ENOENT' ? undefined : Promise.reject(e)))
    await writeFile(join(target, 'head'), `${head}\n`)
    await writeFile(join(root, 'current'), id + '\n')
    return { session: id, head, steps: steps.length, header }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * A manifest is safe to restore when its id is its content, every file's blob is present, and no entry
 * leaves the workdir: relative, no `.`/`..` segments, nothing below a symlink, and no `.envgit`.
 */
export function checkManifest(m: Manifest, blobs: Set<string>, id: SnapshotId): void {
  const bad = (why: string) => new Error(`corrupt export: snapshot ${id.slice(0, 8)}: ${why}`)
  if (!m || !Array.isArray(m.entries)) throw bad('no entries')
  const links = new Set<string>()
  for (const e of m.entries as Entry[]) {
    const segs = typeof e?.path === 'string' ? e.path.split('/') : []
    if (!segs.length || segs.some(s => s === '' || s === '.' || s === '..') || segs[0] === '.envgit') throw bad(`path ${JSON.stringify(e?.path)}`)
    for (let i = 1; i < segs.length; i++) if (links.has(segs.slice(0, i).join('/'))) throw bad(`${e.path} is below a symlink`)
    if (e.kind === 'symlink') {
      if (typeof e.target !== 'string') throw bad(`symlink ${e.path}`)
      links.add(e.path)
    } else if (e.kind === 'file') {
      if (!blobs.has(e.hash) || !Number.isInteger(e.mode)) throw bad(`file ${e.path}`)
    } else if (e.kind !== 'dir' || !Number.isInteger(e.mode)) throw bad(`entry ${e.path}`)
  }
  if (manifestId(m.entries) !== id) throw bad('content does not match its id')
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

/** A regular file's text (never through a symlink an archive planted); `missing` or, if optional, ''. */
async function readRegular(path: string, missing: string, optional = false): Promise<string> {
  const st = await lstat(path).catch(() => undefined)
  if (!st) {
    if (optional) return ''
    throw new Error(missing)
  }
  if (!st.isFile()) throw new Error(`corrupt export: ${path.split('/').slice(-2).join('/')} is not a file`)
  return readFile(path, 'utf8')
}
