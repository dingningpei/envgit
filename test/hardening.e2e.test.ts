import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import { liveSnapshots, readSteps } from '../src/core/snapshot/log.js'
import { SnapshotStore } from '../src/core/snapshot/store.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('M2 hardening (e2e, needs `npm run build`)', () => {
  let dir: string
  let sessionDir: string
  const envgit = (...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-harden-')))
    await envgit('init')
    await envgit('run', 'sh', '-c', 'echo a > f')
    await envgit('run', 'sh', '-c', 'echo b > f')
    const [id] = await readdir(join(dir, '.envgit/sessions'))
    sessionDir = join(dir, '.envgit/sessions', id!)
  }, 60_000)

  it('finishes an interrupted rewind on the next command', async () => {
    const [step0] = await readSteps(sessionDir)
    await writeFile(join(dir, '.envgit/restoring'), JSON.stringify({ session: sessionDir.split('/').pop(), target: 0, snapshot: step0!.snapshot }))
    const r = await envgit('log')
    expect(r.stderr).toMatch(/finished an interrupted rewind to step 0/)
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('a\n')
    expect(r.stdout).toMatch(/head: 0/)
    await expect(readFile(join(dir, '.envgit/restoring'))).rejects.toThrow()
  }, 30_000)

  it('refuses to rewind while a live process holds the busy lock', async () => {
    await writeFile(join(dir, '.envgit/busy'), String(process.pid))
    const r = await envgit('rewind', '0')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/a step is running here/)
    await writeFile(join(dir, '.envgit/busy'), '999999')
    expect((await envgit('rewind', '0')).stderr).toMatch(/rewound to step 0/)
  }, 30_000)

  it('starts a new session with its own base', async () => {
    const before = (await envgit('session')).stdout.trim()
    const created = (await envgit('session', 'new')).stdout.trim()
    expect(created).not.toBe(before)
    const log = (await envgit('log')).stdout
    expect(log).toMatch(new RegExp(`session ${created}`))
    expect(log).toMatch(/base {2}[0-9a-f]{8}/)
    expect(log).toMatch(/head: base$/m)
    expect(await readdir(join(dir, '.envgit/sessions'))).toHaveLength(2)
  }, 30_000)

  it('collects unreferenced snapshots and keeps live ones', async () => {
    const store = new SnapshotStore(join(dir, '.envgit'))
    await writeFile(join(dir, 'orphan.txt'), 'only in an orphan snapshot')
    const orphan = await store.snapshot(dir)
    await envgit('rewind', '1', '--force')
    const r = await store.gc(await liveSnapshots(join(dir, '.envgit')), 0)
    expect(r.snapshots).toBe(1)
    expect(r.blobs).toBe(1)
    expect(await store.has(orphan)).toBe(false)
    expect((await envgit('rewind', '0')).stderr).toMatch(/rewound to step 0/)
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('a\n')
    expect((await envgit('gc')).stdout).toMatch(/removed 0 snapshot\(s\), 0 blob\(s\), 0 leftover temp file\(s\)/)
  }, 30_000)

  it('drops an interrupted vm rewind when the VM is down', async () => {
    const vmSession = join(dir, '.envgit/sessions/vm-old')
    await mkdir(vmSession, { recursive: true })
    await writeFile(join(vmSession, 'session.json'), JSON.stringify({ id: 'vm-old', createdAt: '', backend: 'vm' }))
    await writeFile(join(dir, '.envgit/restoring'), JSON.stringify({ session: 'vm-old', target: 0, snapshot: 'abc' }))
    const r = await envgit('log')
    expect(r.stderr).toMatch(/dropped an interrupted vm rewind/)
    await expect(readFile(join(dir, '.envgit/restoring'))).rejects.toThrow()
  }, 30_000)
})
