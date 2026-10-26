import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit log/rewind/fork (e2e, needs `npm run build`)', () => {
  let dir: string
  const envgit = (cwd: string, ...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd }).catch((e: { code: number; stdout: string; stderr: string }) => e)

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-rewind-')))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub/s.txt'), 'keep')
    await envgit(dir, 'init')
    await envgit(dir, 'run', 'sh', '-c', 'echo a > f')
    await envgit(dir, 'run', process.execPath, '-e', "require('fs').writeFileSync('f','b');require('fs').rmSync('sub',{recursive:true})")
  }, 60_000)

  it('logs the chain with snapshots', async () => {
    const { stdout } = await envgit(dir, 'log')
    expect(stdout).toMatch(/^\s+0 .* exec {2}exit 0 {3}[0-9a-f]{8} {2}sh -c echo a > f/m)
    expect(stdout).toMatch(/head: 1$/m)
  })

  it('rewinds the workdir and keeps the old branch in the log', async () => {
    await envgit(dir, 'rewind', '0')
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('a\n')
    expect(await readFile(join(dir, 'sub/s.txt'), 'utf8')).toBe('keep')
    expect((await envgit(dir, 'log')).stdout).toMatch(/head: 0 \(1 step off this branch\)/)
  }, 30_000)

  it('refuses to drop unrecorded edits without --force', async () => {
    await writeFile(join(dir, 'f'), 'manual')
    const r = await envgit(dir, 'rewind', 'base')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/changes made outside envgit/)
    await envgit(dir, 'rewind', 'base', '--force')
    await expect(readFile(join(dir, 'f'))).rejects.toThrow()
  }, 30_000)

  it('forks a step into a new directory with its own session', async () => {
    const target = join(dir, '..', `${dir.split('/').pop()}-fork`)
    await envgit(dir, 'fork', '1', target)
    expect(await readFile(join(target, 'f'), 'utf8')).toBe('b')
    const { stdout } = await envgit(target, 'log')
    expect(stdout).toMatch(/forked from \S+ step 1/)
  }, 30_000)

  it('restarts a fork that a crash left half-built', async () => {
    const target = join(dir, '..', `${dir.split('/').pop()}-fork2`)
    await mkdir(join(`${target}.forking`, '.envgit/junk'), { recursive: true })
    await writeFile(join(`${target}.forking`, '.envgit/junk/leftover'), 'x')
    await envgit(dir, 'fork', '1', target)
    expect(await readFile(join(target, 'f'), 'utf8')).toBe('b')
    await expect(readFile(join(target, '.envgit/junk/leftover'))).rejects.toThrow()
    await expect(readFile(join(`${target}.forking`, '.envgit/junk/leftover'))).rejects.toThrow()
  }, 30_000)

  it('leaves an unrelated <dir>.forking alone', async () => {
    const target = join(dir, '..', `${dir.split('/').pop()}-fork3`)
    await mkdir(`${target}.forking`)
    await writeFile(join(`${target}.forking`, 'other'), 'mine')
    const r = await envgit(dir, 'fork', '1', target)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/is not a leftover fork/)
    expect(await readFile(join(`${target}.forking`, 'other'), 'utf8')).toBe('mine')
  }, 30_000)

  it('refuses to fork into the workdir itself', async () => {
    const r = await envgit(dir, 'fork', '1', 'nested')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/outside the current workdir/)
  })

  it('warns about irreversible steps it rewinds over', async () => {
    await envgit(dir, 'run', 'git', 'push')
    const r = await envgit(dir, 'rewind', 'base', '--force')
    expect(r.stderr).toMatch(/step \d+ cannot be undone \(shell: git push\)/)
  }, 30_000)

  it('denies sandboxed writes to .envgit', async () => {
    const r = await envgit(dir, 'run', 'sh', '-c', 'echo x > .envgit/x')
    expect(r.code).not.toBe(0)
    await expect(readFile(join(dir, '.envgit/x'))).rejects.toThrow()
  }, 30_000)
})
