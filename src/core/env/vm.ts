/** VM backend: nested Firecracker inside a Virtualization-framework microVM. See docs/design.md §3.6 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, constants, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Command, Env, EnvBackend, EnvSpec, ExecResult, SnapshotId } from './backend.js'

const run = promisify(execFile)

export interface VmMsg {
  op?: string
  error?: string
  argv?: string[]
  env?: string[]
  now_ns?: number
  timeout_ms?: number
  exit?: number
  stdout?: string
  stderr?: string
  id?: string
  parent?: string
  base?: string
  current?: string
  ms?: number
  bytes?: number
  size?: number
}

export function vmDir(): string {
  return process.env.ENVGIT_VM_DIR ?? join(homedir(), '.cache', 'envgit', 'vm')
}

/** Unix socket paths are limited to ~104 bytes, so they live in the cache, keyed by workdir. */
export function vmSocket(workdir: string): string {
  return join(vmDir(), 'run', `${createHash('sha256').update(workdir).digest('hex').slice(0, 12)}.sock`)
}

/** Where envgit-vm sends L2's egress connections; envgit listens here only while a step runs. */
export function vmProxySocket(workdir: string): string {
  return vmSocket(workdir).replace(/\.sock$/, '.proxy.sock')
}

export class VmClient {
  constructor(readonly socket: string) {}

  /** One request per connection: header (+ body) out, header (+ body) back. */
  call(msg: VmMsg, body?: Buffer, timeoutMs = 10 * 60_000): Promise<{ msg: VmMsg; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const c = net.connect(this.socket)
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        c.destroy()
        reject(new Error(`vm: ${msg.op} timed out`))
      }, timeoutMs)
      c.on('data', d => chunks.push(d))
      c.on('error', e => {
        clearTimeout(timer)
        reject(new Error(`vm: ${e.message} (is the VM up? run \`envgit vm up\`)`))
      })
      c.on('end', () => {
        clearTimeout(timer)
        const buf = Buffer.concat(chunks)
        if (buf.length < 4) return reject(new Error(`vm: no reply to ${msg.op}`))
        const n = buf.readUInt32BE(0)
        const reply = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')) as VmMsg
        if (reply.error) return reject(new Error(`vm: ${reply.error}`))
        resolve({ msg: reply, body: buf.subarray(4 + n) })
      })
      const header = Buffer.from(JSON.stringify(body ? { ...msg, size: body.length } : msg))
      const len = Buffer.alloc(4)
      len.writeUInt32BE(header.length)
      c.end(Buffer.concat([len, header, body ?? Buffer.alloc(0)]))
    })
  }

  async alive(): Promise<boolean> {
    return this.call({ op: 'status' }, undefined, 2000).then(
      () => true,
      () => false,
    )
  }
}

export interface VmPaths {
  build: string
  socket: string
  state: string
  /** Shared into L1 over virtiofs; L1 writes every snapshot here before acknowledging it. */
  snaps: string
  proxy: string
}

export function vmPaths(workdir: string): VmPaths {
  const state = join(workdir, '.envgit', 'vm')
  return { build: join(vmDir(), 'build'), socket: vmSocket(workdir), state, snaps: join(state, 'snaps'), proxy: vmProxySocket(workdir) }
}

/**
 * Boots L1 if it is not running and waits for its supervisor. L1 starts with no L2 guest: follow with
 * `VmBackend.boot()` for a fresh one or `restore()` to resume a snapshot. Returns false if it was already up.
 */
export async function vmUp(workdir: string, opts: { cpus?: number; mem?: number; l2mem?: number } = {}): Promise<boolean> {
  const p = vmPaths(workdir)
  const client = new VmClient(p.socket)
  if (await client.alive()) return false
  for (const f of ['envgit-vm', 'Image', 'l1-initrd.cpio']) {
    await stat(join(p.build, f)).catch(() => {
      throw new Error(`vm: ${join(p.build, f)} is missing — run scripts/vm/build.sh`)
    })
  }
  await mkdir(dirname(p.socket), { recursive: true })
  await mkdir(p.snaps, { recursive: true })
  const log = await open(join(p.state, 'console.log'), 'w')
  const child = spawn(
    join(p.build, 'envgit-vm'),
    ['--kernel', join(p.build, 'Image'), '--initrd', join(p.build, 'l1-initrd.cpio'), '--socket', p.socket, '--share', p.snaps, '--proxy-socket', p.proxy,
     '--cpus', String(opts.cpus ?? 4), '--mem', String(opts.mem ?? 4096), '--l2mem', String(opts.l2mem ?? 1024)],
    { detached: true, stdio: ['ignore', log.fd, log.fd] },
  )
  child.unref()
  await log.close()
  await writeFile(join(p.state, 'helper.pid'), `${child.pid}\n`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await client.alive()) return true
    if (child.exitCode !== null) break
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`vm: L1 did not come up; see ${join(p.state, 'console.log')}`)
}

export async function vmDown(workdir: string): Promise<boolean> {
  const p = vmPaths(workdir)
  const client = new VmClient(p.socket)
  if (!(await client.alive())) return false
  await client.call({ op: 'shutdown' }).catch(() => {})
  const pid = Number(await readFile(join(p.state, 'helper.pid'), 'utf8').catch(() => ''))
  for (let i = 0; i < 40 && pid; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return true
}

// ---- snapshots on the host ----

interface VmSnapshotMeta {
  id: string
  parent?: string
  kind: 'Full' | 'Diff'
}

async function readSnapMeta(snaps: string, id: string): Promise<VmSnapshotMeta | undefined> {
  return readFile(join(snaps, id, 'meta.json'), 'utf8').then(t => JSON.parse(t) as VmSnapshotMeta, () => undefined)
}

export async function vmSnapshotExists(workdir: string, id: string): Promise<boolean> {
  return (await readSnapMeta(vmPaths(workdir).snaps, id)) !== undefined
}

/** `ids` and every snapshot their diffs build on, down to the full base. */
export async function vmSnapshotClosure(snaps: string, ids: Iterable<string>): Promise<Set<string>> {
  const keep = new Set<string>()
  for (let id of ids) {
    while (id && !keep.has(id)) {
      const meta = await readSnapMeta(snaps, id)
      if (!meta) break
      keep.add(id)
      id = meta.parent ?? ''
    }
  }
  return keep
}

/** Deletes VM snapshots nothing live builds on, plus temp dirs an interrupted write left. */
export async function gcVmSnapshots(workdir: string, live: Set<string>): Promise<{ snapshots: number; bytes: number }> {
  const snaps = vmPaths(workdir).snaps
  const keep = await vmSnapshotClosure(snaps, live)
  let snapshots = 0
  let bytes = 0
  for (const name of await readdir(snaps).catch(() => [] as string[])) {
    if (keep.has(name)) continue
    // A snapshot that is still being written has no meta.json yet; leave fresh ones alone.
    const st = await stat(join(snaps, name)).catch(() => undefined)
    if (!st || Date.now() - st.ctimeMs < 60 * 60_000) continue
    for (const f of await readdir(join(snaps, name)).catch(() => [] as string[])) bytes += (await stat(join(snaps, name, f)).catch(() => ({ size: 0 }))).size
    await rm(join(snaps, name), { recursive: true, force: true })
    if (!name.startsWith('.tmp-')) snapshots++
  }
  return { snapshots, bytes }
}

/** Clones (APFS copy-on-write where possible) `id` and its whole chain into another workdir. */
export async function copyVmSnapshots(fromWorkdir: string, toWorkdir: string, id: string): Promise<void> {
  const from = vmPaths(fromWorkdir).snaps
  const to = vmPaths(toWorkdir).snaps
  await mkdir(to, { recursive: true })
  for (const sid of await vmSnapshotClosure(from, [id])) {
    await mkdir(join(to, sid), { recursive: true })
    for (const f of await readdir(join(from, sid))) await copyFile(join(from, sid, f), join(to, sid, f), constants.COPYFILE_FICLONE)
  }
}

// ---- workdir transfer ----

/** Tars `paths` (relative to workdir; default everything) leaving `.envgit` and `exclude` out. */
export async function tarFrom(workdir: string, paths: string[] = ['.'], exclude: string[] = []): Promise<Buffer> {
  const args = ['-c', '-f', '-', '--exclude', './.envgit', '--exclude', '.envgit', ...exclude.flatMap(e => ['--exclude', e]), '-C', workdir, ...paths]
  // COPYFILE_DISABLE keeps macOS from adding ._ AppleDouble files.
  const { stdout } = await run('tar', args, { encoding: 'buffer', maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return stdout
}

interface MirrorEntry {
  /** Hash of what the guest had there at the last sync (and what the mirror then wrote). */
  h: string
  /** The guest's change key for it (inode, size, ctime, mode): unchanged key, unchanged file. */
  k?: string
}

interface MirrorManifest {
  files: Record<string, MirrorEntry>
}

/** One file or symlink in the guest's /work, from an export listing. */
export interface GuestEntry {
  p: string
  k: string
}

export interface MirrorResult {
  written: number
  removed: number
  refused: number
  /** Host files edited since the last sync that the guest also changed; left alone, not pushed. */
  conflicts: string[]
  /** What changed in the guest since the last sync. */
  changed: string[]
  deleted: string[]
}

/**
 * Makes the host workdir mirror L2's /work: writes every entry of `tar`, and deletes only paths that
 * an earlier mirror wrote and the guest no longer has — never files envgit did not put there.
 * With a `listing` (every path the guest has), `tar` holds only what changed since the last sync and
 * listed paths missing from it are unchanged; without one, `tar` is the guest's whole /work.
 * A host file that differs from what the last sync left there was edited on the host and has not been
 * pushed: it is kept and reported as a conflict instead of being overwritten or deleted.
 */
export async function applyMirror(workdir: string, tar: Buffer, listing?: GuestEntry[]): Promise<MirrorResult> {
  const state = join(workdir, '.envgit', 'vm')
  await mkdir(state, { recursive: true })
  const tmp = await mkdtemp(join(state, 'mirror-'))
  try {
    await new Promise<void>((resolve, reject) => {
      const t = spawn('tar', ['-x', '-f', '-', '-C', tmp], { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      t.stderr.on('data', d => (err += d))
      t.on('close', code => (code === 0 ? resolve() : reject(new Error(`vm: tar -x failed: ${err}`))))
      t.stdin.end(tar)
    })
    const manifestPath = join(state, 'mirror.json')
    const prev = await readManifest(workdir)
    // The guest never gets to name envgit's own state, for writes or deletes.
    const ours = (f: string) => f === '.envgit' || f.startsWith('.envgit/')
    const files = (await walk(tmp)).filter(f => !ours(f))
    const keys = new Map((listing ?? []).map(e => [e.p, e.k]))
    const realRoot = await realpath(workdir)
    const next: Record<string, MirrorEntry> = {}
    // Listed but not sent: the guest says it is unchanged since the last sync.
    for (const [rel, k] of keys) if (!ours(rel) && prev?.[rel]) next[rel] = { ...prev[rel], k }
    const r: MirrorResult = { written: 0, removed: 0, refused: 0, conflicts: [], changed: [], deleted: [] }
    for (const rel of files) {
      const src = join(tmp, rel)
      const dst = join(workdir, rel)
      const want = (await hashEntry(src))!
      next[rel] = { h: want, ...(keys.has(rel) && { k: keys.get(rel) }) }
      if (prev?.[rel]?.h !== want) r.changed.push(rel)
      if (!(await insideWorkdir(realRoot, workdir, rel))) {
        r.refused++
        continue
      }
      const have = await hashEntry(dst)
      if (have === want) continue
      // Edited on the host since the last sync (or, with no manifest yet, never synced): keep it.
      if (have !== undefined && editedOnHost(have, prev?.[rel]?.h)) {
        r.conflicts.push(rel)
        continue
      }
      await mkdir(dirname(dst), { recursive: true })
      const st = await lstat(src)
      await rm(dst, { force: true, recursive: true })
      if (st.isSymbolicLink()) {
        await symlink(await readlink(src), dst)
      } else {
        await copyFile(src, dst)
        await chmod(dst, st.mode & 0o7777)
      }
      r.written++
    }
    for (const [rel, { h: hash }] of Object.entries(prev ?? {})) {
      if (rel in next || ours(rel)) continue
      // A listed path whose unchanged copy this sync could not vouch for is not a deletion.
      if (keys.has(rel)) continue
      r.deleted.push(rel)
      if (!(await insideWorkdir(realRoot, workdir, rel))) {
        r.refused++
        continue
      }
      const have = await hashEntry(join(workdir, rel))
      if (have === undefined) continue
      if (editedOnHost(have, hash)) {
        r.conflicts.push(rel)
        continue
      }
      await rm(join(workdir, rel), { force: true })
      r.removed++
    }
    await writeFile(manifestPath, JSON.stringify({ files: next } satisfies MirrorManifest))
    return r
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function editedOnHost(have: string, synced: string | undefined): boolean {
  return synced !== '*' && have !== synced
}

/** `undefined` when there is no manifest yet. A pre-hash manifest (a path list) trusts the host files it names. */
async function readManifest(workdir: string): Promise<Record<string, MirrorEntry> | undefined> {
  const text = await readFile(join(workdir, '.envgit', 'vm', 'mirror.json'), 'utf8').catch(() => '')
  if (!text) return undefined
  const m = JSON.parse(text) as { files: string[] | Record<string, string | MirrorEntry> }
  if (Array.isArray(m.files)) return Object.fromEntries(m.files.map(f => [f, { h: '*' }]))
  return Object.fromEntries(Object.entries(m.files).map(([f, e]) => [f, typeof e === 'string' ? { h: e } : e]))
}

/** Guest keys of what the host mirror already holds, for an incremental export. */
export async function mirrorKeys(workdir: string): Promise<Record<string, string>> {
  const m = await readManifest(workdir)
  return Object.fromEntries(Object.entries(m ?? {}).flatMap(([f, e]) => (e.k ? [[f, e.k]] : [])))
}

/** Hash of a regular file (content + exec bit) or symlink (target); undefined if absent or neither. */
async function hashEntry(path: string): Promise<string | undefined> {
  const st = await lstat(path).catch(() => undefined)
  if (!st) return undefined
  const h = createHash('sha256')
  if (st.isSymbolicLink()) h.update('l\0').update(await readlink(path))
  else if (st.isFile()) h.update(`f${st.mode & 0o111 ? 'x' : '-'}\0`).update(await readFile(path))
  else return undefined
  return h.digest('hex')
}

/**
 * Whether host path `rel` resolves inside the workdir. A guest can leave a symlink on the host and
 * later send a directory of the same name; following it would write or delete outside the workdir.
 * Walks the existing part of the parent chain (creating nothing) and resolves it.
 */
async function insideWorkdir(realRoot: string, workdir: string, rel: string): Promise<boolean> {
  let dir = dirname(join(workdir, rel))
  for (;;) {
    const real = await realpath(dir).catch(() => undefined)
    if (real !== undefined) return real === realRoot || real.startsWith(realRoot + '/')
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

/** Regular files and symlinks under `dir`, relative, sorted. */
async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const d of (await readdir(join(dir, rel), { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...(await walk(dir, p)))
    else if (d.isFile() || d.isSymbolicLink()) out.push(p)
  }
  return out
}

// ---- EnvBackend ----

export class VmBackend implements EnvBackend {
  readonly name = 'vm'
  private client: VmClient
  private workdir = ''

  constructor(socket?: string) {
    this.client = new VmClient(socket ?? '')
  }

  async create(spec: EnvSpec): Promise<Env> {
    this.workdir = spec.workdir
    if (!this.client.socket) this.client = new VmClient(vmSocket(spec.workdir))
    if (!(await this.client.alive())) throw new Error('vm: not running here — run `envgit vm up` first')
    return { id: randomUUID(), backend: this.name }
  }

  async exec(_env: Env, cmd: Command): Promise<ExecResult> {
    const env = cmd.env && Object.entries(cmd.env).map(([k, v]) => `${k}=${v}`)
    const { msg } = await this.client.call({ op: 'exec', argv: cmd.argv, now_ns: Date.now() * 1e6, ...(env && { env }) })
    if (msg.stdout) process.stdout.write(msg.stdout)
    if (msg.stderr) process.stderr.write(msg.stderr)
    // Writes stay inside the snapshot boundary; network effects come from the host-side gate (vm-egress.ts).
    return { exitCode: msg.exit ?? 1, stdout: msg.stdout ?? '', stderr: msg.stderr ?? '', effects: [] }
  }

  /** Sets L2's CA bundle: its own roots plus `extraPem` (the host proxy's per-run CA, if any). */
  async trust(extraPem: string): Promise<void> {
    await this.client.call({ op: 'trust' }, Buffer.from(extraPem))
  }

  /** Starts a fresh L2 guest (empty /work) and returns its full base snapshot. */
  async boot(): Promise<SnapshotId> {
    return (await this.client.call({ op: 'boot' })).msg.id as SnapshotId
  }

  async snapshot(): Promise<SnapshotId> {
    return (await this.client.call({ op: 'snapshot' })).msg.id as SnapshotId
  }

  async restore(id: SnapshotId): Promise<Env> {
    await this.client.call({ op: 'restore', id })
    return { id: randomUUID(), backend: this.name }
  }

  async importTar(tar: Buffer): Promise<void> {
    await this.client.call({ op: 'import' }, tar)
  }

  /** Lists L2's /work and tars what differs from `known` (path → guest key). */
  async exportTar(known: Record<string, string> = {}): Promise<{ listing: GuestEntry[]; tar: Buffer }> {
    const { body } = await this.client.call({ op: 'export' }, Buffer.from(JSON.stringify(known)))
    const n = body.readUInt32BE(0)
    return { listing: JSON.parse(body.subarray(4, 4 + n).toString('utf8')) as GuestEntry[], tar: body.subarray(4 + n) }
  }

  /** Pulls what changed in L2's /work since the last sync into the host workdir mirror. */
  async syncMirror(): Promise<MirrorResult> {
    const { listing, tar } = await this.exportTar(await mirrorKeys(this.workdir))
    return applyMirror(this.workdir, tar, listing)
  }

  async destroy(): Promise<void> {}
}
