import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { acquireBusy, busyHolder, releaseBusy } from '../src/core/snapshot/lock.js'

const lstart = (pid: number) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'envgit-lock-'))
})

describe('busy lock', () => {
  it('reports a live holder with a matching start time', async () => {
    const child = spawn('sleep', ['30'])
    try {
      await writeFile(join(root, 'busy'), JSON.stringify({ pid: child.pid, started: lstart(child.pid!) }))
      expect(await busyHolder(root)).toBe(child.pid)
      await expect(acquireBusy(root)).rejects.toThrow(/another envgit process/)
    } finally {
      child.kill()
    }
  })

  it('treats a dead pid as free and takes the lock over', async () => {
    await writeFile(join(root, 'busy'), JSON.stringify({ pid: 999999 }))
    expect(await busyHolder(root)).toBeUndefined()
    await acquireBusy(root)
    expect(JSON.parse(await readFile(join(root, 'busy'), 'utf8')).pid).toBe(process.pid)
  })

  it('treats a reused pid (different start time) as free', async () => {
    await writeFile(join(root, 'busy'), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    expect(await busyHolder(root)).toBeUndefined()
  })

  it('is reentrant for the holder and released by it', async () => {
    await acquireBusy(root)
    await acquireBusy(root)
    expect(await busyHolder(root)).toBe(process.pid)
    await releaseBusy(root)
    expect(await busyHolder(root)).toBeUndefined()
  })

  it('reads legacy plain-pid lock files', async () => {
    await writeFile(join(root, 'busy'), String(process.ppid))
    expect(await busyHolder(root)).toBe(process.ppid)
  })
})
