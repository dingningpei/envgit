import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SnapshotId } from '../src/core/env/backend.js'
import { manifestId, type Entry } from '../src/core/snapshot/store.js'
import { checkManifest } from '../src/core/snapshot/transfer.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const H = 'a'.repeat(64)

describe('checkManifest', () => {
  const check = (entries: Entry[]) => checkManifest({ at: 0, entries }, new Set([H]), manifestId(entries))
  const file = (path: string): Entry => ({ path, kind: 'file', mode: 0o644, size: 1, mtimeMs: 0, hash: H })

  it('takes a manifest whose paths stay in the workdir', () => {
    expect(() => check([{ path: 'a', kind: 'dir', mode: 0o755 }, file('a/b'), { path: 'l', kind: 'symlink', target: '../elsewhere' }])).not.toThrow()
  })

  it('refuses a way out of the workdir, a missing blob, or content that is not its id', () => {
    expect(() => check([file('../x')])).toThrow(/path "\.\.\/x"/)
    expect(() => check([file('/etc/passwd')])).toThrow(/path/)
    expect(() => check([file('.envgit/current')])).toThrow(/path/)
    // A symlink to /etc, then a file "inside" it: restore would write /etc/passwd.
    expect(() => check([{ path: 'l', kind: 'symlink', target: '/etc' }, file('l/passwd')])).toThrow(/below a symlink/)
    expect(() => check([{ ...file('x'), hash: 'b'.repeat(64) } as Entry])).toThrow(/file x/)
    expect(() => checkManifest({ at: 0, entries: [file('x')] }, new Set([H]), 'c'.repeat(64) as SnapshotId)).toThrow(/does not match its id/)
  })
})

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit export/import (e2e, needs `npm run build`)', () => {
  let a: string
  let b: string
  let archive: string
  const envgit = (cwd: string, ...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd }).catch((e: { code: number; stdout: string; stderr: string }) => e)

  beforeAll(async () => {
    const top = await realpath(await mkdtemp(join(tmpdir(), 'envgit-transfer-')))
    a = join(top, 'a')
    b = join(top, 'b')
    await mkdir(a)
    await mkdir(b)
    await writeFile(join(a, 'keep.txt'), 'base')
    await envgit(a, 'init')
    await envgit(a, 'run', 'sh', '-c', 'echo one > f')
    await envgit(a, 'run', 'sh', '-c', 'echo two > f && mkdir -p d && echo x > d/y')
    archive = join(top, 'session.tar.gz')
    const r = await envgit(a, 'export', '-o', archive)
    expect(r.stderr).toMatch(/exported session \S+ \(3 snapshot\(s\), \d+ blob\(s\)\)/)
    await writeFile(join(b, 'other.txt'), 'b was here')
    await envgit(b, 'init')
  }, 60_000)

  it('imports a session with its log and makes it current', async () => {
    const r = await envgit(b, 'import', archive)
    expect(r.stderr).toMatch(/imported session \S+ \(2 step\(s\), from agent-envgit [\d.]+\); it is now current, at step 1/)
    expect(r.stderr).toMatch(/envgit rewind 1 --force/)
    const log = (await envgit(b, 'log')).stdout
    expect(log).toMatch(/sh -c echo one > f/)
    expect(log).toMatch(/head: 1$/m)
    expect(await readFile(join(b, '.envgit/sessions', (await readFile(join(b, '.envgit/current'), 'utf8')).trim(), 'policy.yaml'), 'utf8')).toMatch(/preset: default/)
  }, 30_000)

  it('rewinds the imported session on this machine', async () => {
    expect((await envgit(b, 'rewind', '1')).stderr).toMatch(/changes made outside envgit/)
    await envgit(b, 'rewind', '1', '--force')
    expect(await readFile(join(b, 'f'), 'utf8')).toBe('two\n')
    expect(await readFile(join(b, 'd/y'), 'utf8')).toBe('x\n')
    expect(await readFile(join(b, 'keep.txt'), 'utf8')).toBe('base')
    await expect(readFile(join(b, 'other.txt'))).rejects.toThrow()
    await envgit(b, 'rewind', '0')
    expect(await readFile(join(b, 'f'), 'utf8')).toBe('one\n')
  }, 30_000)

  it('refuses the same session twice, and an archive that was tampered with', async () => {
    expect((await envgit(b, 'import', archive)).stderr).toMatch(/already exists here/)
    // Unpack, swap one blob's content, pack again.
    const t = await realpath(await mkdtemp(join(tmpdir(), 'envgit-tamper-')))
    await run('tar', ['-xzf', archive, '-C', t])
    const blob = (await readdir(join(t, 'objects')))[0]!
    await rm(join(t, 'objects', blob), { force: true })
    await writeFile(join(t, 'objects', blob), 'evil')
    const bad = join(t, '..', 'bad.tar.gz')
    await run('tar', ['-czf', bad, '-C', t, '.'])
    const c = await realpath(await mkdtemp(join(tmpdir(), 'envgit-transfer-c-')))
    await envgit(c, 'init')
    const r = await envgit(c, 'import', bad)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/corrupt export: object/)
    await expect(readdir(join(c, '.envgit/sessions'))).resolves.toEqual([])
    // A symlink where a file should be is refused too.
    await rm(join(t, 'objects', blob))
    await symlink('/etc/hosts', join(t, 'objects', blob))
    await run('tar', ['-czf', bad, '-C', t, '.'])
    expect((await envgit(c, 'import', bad)).stderr).toMatch(/corrupt export: object/)
  }, 30_000)
})
