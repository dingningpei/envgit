import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendStep, nextStepIndex, openSession, readSteps, type Step } from '../src/core/snapshot/log.js'

const step = (index: number): Step => ({
  index,
  startedAt: 't0',
  endedAt: 't1',
  action: { type: 'exec', input: '["true"]' },
  exitCode: 0,
  effects: [],
})

describe('action log', () => {
  it('reuses the current session and appends steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'envgit-'))
    const a = await openSession(root, 'srt')
    expect(await nextStepIndex(a.dir)).toBe(0)
    await appendStep(a.dir, step(0))
    const b = await openSession(root, 'srt')
    expect(b.meta.id).toBe(a.meta.id)
    expect(await nextStepIndex(b.dir)).toBe(1)
    await appendStep(b.dir, step(1))
    expect((await readSteps(b.dir)).map(s => s.index)).toEqual([0, 1])
    expect((await readFile(join(root, 'current'), 'utf8')).trim()).toBe(a.meta.id)
  })
})
