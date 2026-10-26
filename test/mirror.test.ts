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

  it('keeps host edits that were not pushed instead of overwriting or deleting them', async () => {
    await writeFile(join(guest, 'a.txt'), 'one')
    await writeFile(join(guest, 'b.txt'), 'two')
    await applyMirror(work, tarOf(guest))
    await writeFile(join(work, 'a.txt'), 'edited on host')
    await writeFile(join(work, 'b.txt'), 'edited on host too')
    const next = await fresh()
    await writeFile(join(next, 'a.txt'), 'guest changed it')
    // b.txt deleted in the guest; c.txt created in both places.
    await writeFile(join(next, 'c.txt'), 'guest c')
    await writeFile(join(work, 'c.txt'), 'host c')
    const r = await applyMirror(work, tarOf(next))
    expect(r.conflicts.sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(await readFile(join(work, 'a.txt'), 'utf8')).toBe('edited on host')
    expect(await readFile(join(work, 'b.txt'), 'utf8')).toBe('edited on host too')
    expect(await readFile(join(work, 'c.txt'), 'utf8')).toBe('host c')
    // Once the guest has the host's content (a push), the file is in sync again.
    const pushed = await fresh()
    await writeFile(join(pushed, 'a.txt'), 'edited on host')
    expect((await applyMirror(work, tarOf(pushed))).conflicts).not.toContain('a.txt')
  })

  it('reports what changed in the guest since the last sync', async () => {
    await writeFile(join(guest, 'same.txt'), 's')
    await writeFile(join(guest, 'gone.txt'), 'g')
    expect((await applyMirror(work, tarOf(guest))).changed.sort()).toEqual(['gone.txt', 'same.txt'])
    const next = await fresh()
    await writeFile(join(next, 'same.txt'), 's')
    await writeFile(join(next, 'new.txt'), 'n')
    const r = await applyMirror(work, tarOf(next))
    expect(r).toMatchObject({ changed: ['new.txt'], deleted: ['gone.txt'], conflicts: [] })
  })

  it('reads a manifest from before hashes without flagging every file', async () => {
    await writeFile(join(work, 'old.txt'), 'written by an older envgit')
    await mkdir(join(work, '.envgit/vm'), { recursive: true })
    await writeFile(join(work, '.envgit/vm/mirror.json'), JSON.stringify({ files: ['old.txt'] }))
    await writeFile(join(guest, 'old.txt'), 'new guest content')
    const r = await applyMirror(work, tarOf(guest))
    expect(r.conflicts).toEqual([])
    expect(await readFile(join(work, 'old.txt'), 'utf8')).toBe('new guest content')
  })

  it('applies an incremental export: unsent listed paths are unchanged, unlisted ones deleted', async () => {
    await writeFile(join(guest, 'keep.txt'), 'k')
    await writeFile(join(guest, 'gone.txt'), 'g')
    await applyMirror(work, tarOf(guest), [{ p: 'keep.txt', k: '1' }, { p: 'gone.txt', k: '2' }])
    const next = await fresh()
    await writeFile(join(next, 'new.txt'), 'n')
    const r = await applyMirror(work, tarOf(next), [{ p: 'keep.txt', k: '1' }, { p: 'new.txt', k: '3' }])
    expect(r).toMatchObject({ changed: ['new.txt'], deleted: ['gone.txt'], removed: 1, conflicts: [] })
    expect(await readFile(join(work, 'keep.txt'), 'utf8')).toBe('k')
    expect(JSON.parse(await readFile(join(work, '.envgit/vm/mirror.json'), 'utf8')).files['keep.txt'].k).toBe('1')
  })
})
