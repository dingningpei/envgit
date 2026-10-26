import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/core/snapshot/store.js'

let work: string
let store: SnapshotStore

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'envgit-store-'))
  store = new SnapshotStore(join(work, '.envgit'))
  await mkdir(join(work, 'sub/deep'), { recursive: true })
  await mkdir(join(work, 'empty'))
  await writeFile(join(work, 'a.txt'), 'a')
  await writeFile(join(work, 'sub/b.sh'), '#!/bin/sh\n')
  await chmod(join(work, 'sub/b.sh'), 0o755)
  await writeFile(join(work, 'sub/deep/c.txt'), 'c')
  await symlink('a.txt', join(work, 'link'))
  await mkdir(join(work, 'node_modules'))
  await writeFile(join(work, 'node_modules/x.js'), 'x')
})

describe('SnapshotStore', () => {
  it('restores adds, edits, deletes, modes, links and empty dirs', async () => {
    const id = await store.snapshot(work)
    await writeFile(join(work, 'a.txt'), 'changed')
    await writeFile(join(work, 'new.txt'), 'new')
    await rm(join(work, 'sub'), { recursive: true })
    await rm(join(work, 'empty'), { recursive: true })
    await rm(join(work, 'link'))
    await symlink('new.txt', join(work, 'link'))
    await writeFile(join(work, '.envgit/keep'), 'state')

    await store.restore(work, id)

    expect(await readFile(join(work, 'a.txt'), 'utf8')).toBe('a')
    expect(await lstat(join(work, 'new.txt')).catch(() => null)).toBeNull()
    expect(await readFile(join(work, 'sub/deep/c.txt'), 'utf8')).toBe('c')
    expect((await lstat(join(work, 'sub/b.sh'))).mode & 0o777).toBe(0o755)
    expect((await lstat(join(work, 'empty'))).isDirectory()).toBe(true)
    expect(await readlink(join(work, 'link'))).toBe('a.txt')
    expect(await readFile(join(work, '.envgit/keep'), 'utf8')).toBe('state')
    expect(await store.snapshot(work, [], await store.read(id))).toBe(id)
  })

  it('gives an unchanged tree the same id and replaces a file with a dir', async () => {
    const id = await store.snapshot(work)
    expect(await store.snapshot(work, [], await store.read(id))).toBe(id)
    await rm(join(work, 'a.txt'))
    await mkdir(join(work, 'a.txt'))
    await store.restore(work, id)
    expect(await readFile(join(work, 'a.txt'), 'utf8')).toBe('a')
  })

  it('honors exclusions on snapshot and restore', async () => {
    const id = await store.snapshot(work, ['node_modules'])
    expect((await store.read(id)).entries.some(e => e.path.startsWith('node_modules'))).toBe(false)
    await writeFile(join(work, 'node_modules/x.js'), 'kept')
    await store.restore(work, id, ['node_modules'])
    expect(await readFile(join(work, 'node_modules/x.js'), 'utf8')).toBe('kept')
  })

  it('derives the id from content, not mtimes', async () => {
    const a = await store.snapshot(work)
    await writeFile(join(work, 'a.txt'), 'a')
    const b = await store.snapshot(work, [], await store.read(a))
    expect(b).toBe(a)
    await writeFile(join(work, 'a.txt'), 'b')
    expect(await store.snapshot(work, [], await store.read(b))).not.toBe(a)
  })

  it('leaves FIFOs alone on snapshot and restore', async () => {
    execFileSync('mkfifo', [join(work, 'pipe')])
    const id = await store.snapshot(work)
    expect((await store.read(id)).entries.some(e => e.path === 'pipe')).toBe(false)
    await store.restore(work, id)
    expect((await lstat(join(work, 'pipe'))).isFIFO()).toBe(true)
  })

  it('rehashes files modified close to the previous snapshot', async () => {
    const before = await stat(join(work, 'a.txt'))
    const first = await store.snapshot(work)
    await writeFile(join(work, 'a.txt'), 'z')
    await utimes(join(work, 'a.txt'), before.atime, before.mtime)
    expect(await store.snapshot(work, [], await store.read(first))).not.toBe(first)
  })

  it('trusts cached hashes of files older than the previous snapshot', async () => {
    const old = new Date(Date.now() - 3600_000)
    await utimes(join(work, 'a.txt'), old, old)
    const first = await store.snapshot(work)
    await writeFile(join(work, 'a.txt'), 'z')
    await utimes(join(work, 'a.txt'), old, old)
    // Same size, mode and mtime as cached: not re-read, by design.
    expect(await store.snapshot(work, [], await store.read(first))).toBe(first)
  })

  it('computes an id without writing when persist is false', async () => {
    const id = await store.snapshot(work, [], undefined, { persist: false })
    await expect(readdir(join(work, '.envgit'))).rejects.toThrow()
    expect(await store.snapshot(work)).toBe(id)
  })

  it('copies a snapshot into another store', async () => {
    const id = await store.snapshot(work)
    const other = await mkdtemp(join(tmpdir(), 'envgit-fork-'))
    const otherStore = new SnapshotStore(join(other, '.envgit'))
    await store.copyTo(otherStore, id)
    await otherStore.restore(other, id)
    expect(await readFile(join(other, 'sub/deep/c.txt'), 'utf8')).toBe('c')
  })
})
