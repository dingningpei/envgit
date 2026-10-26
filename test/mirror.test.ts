import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMirror } from '../src/core/env/vm.js'

let work: string
let guest: string

const tarOf = (dir: string) => execFileSync('tar', ['-c', '-f', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
const fresh = async () => realpath(await mkdtemp(join(tmpdir(), 'envgit-guest-')))

beforeEach(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), 'envgit-mirror-')))
  await mkdir(join(work, '.envgit/sessions/s1'), { recursive: true })
  await writeFile(join(work, '.envgit/sessions/s1/steps.jsonl'), 'history\n')
  await writeFile(join(work, 'mine.txt'), 'not from the guest\n')
  guest = await fresh()
})

describe('applyMirror', () => {
  it('writes, updates and deletes only what the guest previously sent', async () => {
    await writeFile(join(guest, 'a.txt'), 'one')
    await mkdir(join(guest, 'sub'))
    await writeFile(join(guest, 'sub/b.txt'), 'two')
    expect(await applyMirror(work, tarOf(guest))).toMatchObject({ written: 2, removed: 0, refused: 0 })
    const next = await fresh()
    await writeFile(join(next, 'a.txt'), 'changed')
    expect(await applyMirror(work, tarOf(next))).toMatchObject({ written: 1, removed: 1 })
    expect(await readFile(join(work, 'a.txt'), 'utf8')).toBe('changed')
    await expect(readFile(join(work, 'sub/b.txt'))).rejects.toThrow()
    expect(await readFile(join(work, 'mine.txt'), 'utf8')).toBe('not from the guest\n')
  })

  it('never writes or deletes envgit state on the guest\'s say-so', async () => {
    await mkdir(join(guest, '.envgit/sessions/s1'), { recursive: true })
    await writeFile(join(guest, '.envgit/sessions/s1/steps.jsonl'), 'forged\n')
    await applyMirror(work, tarOf(guest))
    expect(await readFile(join(work, '.envgit/sessions/s1/steps.jsonl'), 'utf8')).toBe('history\n')
    await applyMirror(work, tarOf(await fresh()))
    expect(await readFile(join(work, '.envgit/sessions/s1/steps.jsonl'), 'utf8')).toBe('history\n')
  })

  it('refuses to follow a symlink it left on the host out of the workdir', async () => {
    const outside = await fresh()
    await symlink(outside, join(guest, 'a'))
    await writeFile(join(guest, 'victim.txt'), 'x')
    await applyMirror(work, tarOf(guest))
    // Next step: `a` is a directory with a file in it.
    const next = await fresh()
    await mkdir(join(next, 'a'))
    await writeFile(join(next, 'a/pwn'), 'escaped')
    const r = await applyMirror(work, tarOf(next))
    expect(r.refused).toBeGreaterThan(0)
    expect(await readdir(outside)).toEqual([])
  })
})
