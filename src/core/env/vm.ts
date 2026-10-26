/** VM backend: nested Firecracker inside a Virtualization-framework microVM. See docs/design.md §3.6 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
}

export function vmPaths(workdir: string): VmPaths {
  return { build: join(vmDir(), 'build'), socket: vmSocket(workdir), state: join(workdir, '.envgit', 'vm') }
}

/** Boots the VM if it is not running and waits for the L1 supervisor. Returns false if it was already up. */
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
  await mkdir(p.state, { recursive: true })
  const log = await open(join(p.state, 'console.log'), 'w')
  const child = spawn(
    join(p.build, 'envgit-vm'),
    ['--kernel', join(p.build, 'Image'), '--initrd', join(p.build, 'l1-initrd.cpio'), '--socket', p.socket,
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

// ---- workdir transfer ----

/** Tars `paths` (relative to workdir; default everything) leaving `.envgit` and `exclude` out. */
export async function tarFrom(workdir: string, paths: string[] = ['.'], exclude: string[] = []): Promise<Buffer> {
  const args = ['-c', '-f', '-', '--exclude', './.envgit', '--exclude', '.envgit', ...exclude.flatMap(e => ['--exclude', e]), '-C', workdir, ...paths]
  // COPYFILE_DISABLE keeps macOS from adding ._ AppleDouble files.
  const { stdout } = await run('tar', args, { encoding: 'buffer', maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return stdout
}

interface MirrorManifest {
  files: string[]
}

/**
 * Makes the host workdir mirror L2's /work: writes every entry of `tar`, and deletes only paths that
 * an earlier mirror wrote and the guest no longer has — never files envgit did not put there.
 */
export async function applyMirror(workdir: string, tar: Buffer): Promise<{ written: number; removed: number; refused: number }> {
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
    // The guest never gets to name envgit's own state, for writes or deletes.
    const files = (await walk(tmp)).filter(f => f !== '.envgit' && !f.startsWith('.envgit/'))
    const realRoot = await realpath(workdir)
    let written = 0
    let refused = 0
    for (const rel of files) {
      const src = join(tmp, rel)
      const dst = join(workdir, rel)
      const st = await lstat(src)
      if (!(await insideWorkdir(realRoot, workdir, rel))) {
        refused++
        continue
      }
      await mkdir(dirname(dst), { recursive: true })
      if (st.isSymbolicLink()) {
        const target = await readlink(src)
        const cur = await readlink(dst).catch(() => undefined)
        if (cur === target) continue
        await rm(dst, { force: true, recursive: true })
        await symlink(target, dst)
      } else {
        if (await sameFile(src, dst)) continue
        await rm(dst, { force: true, recursive: true })
        await copyFile(src, dst)
        await chmod(dst, st.mode & 0o7777)
      }
      written++
    }
    const manifestPath = join(state, 'mirror.json')
    const prev = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{"files":[]}')) as MirrorManifest
    const now = new Set(files)
    let removed = 0
    for (const rel of prev.files) {
      if (now.has(rel) || rel === '.envgit' || rel.startsWith('.envgit/')) continue
      if (!(await insideWorkdir(realRoot, workdir, rel))) {
        refused++
        continue
      }
      await rm(join(workdir, rel), { force: true })
      removed++
    }
    await writeFile(manifestPath, JSON.stringify({ files } satisfies MirrorManifest))
    return { written, removed, refused }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
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

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstat(a), lstat(b).catch(() => undefined)])
  if (!sb || !sb.isFile() || sa.size !== sb.size || (sa.mode & 0o7777) !== (sb.mode & 0o7777)) return false
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
  return ba.equals(bb)
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
    const { msg } = await this.client.call({ op: 'exec', argv: cmd.argv })
    if (msg.stdout) process.stdout.write(msg.stdout)
    if (msg.stderr) process.stderr.write(msg.stderr)
    // L2 has no network and its writes stay inside the snapshot boundary, so there is nothing to record yet.
    return { exitCode: msg.exit ?? 1, stdout: msg.stdout ?? '', stderr: msg.stderr ?? '', effects: [] }
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

  async exportTar(): Promise<Buffer> {
    return (await this.client.call({ op: 'export' })).body
  }

  /** Pulls L2's /work into the host workdir mirror. */
  async syncMirror(): Promise<{ written: number; removed: number; refused: number }> {
    return applyMirror(this.workdir, await this.exportTar())
  }

  async destroy(): Promise<void> {}
}
