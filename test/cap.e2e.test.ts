import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseBytes } from '../src/core/snapshot/cap.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

describe('snapshot.maxBytes sizes', () => {
  it('reads sizes with units', () => {
    expect(parseBytes(1234)).toBe(1234)
    expect(parseBytes('500M')).toBe(500 * 1024 ** 2)
    expect(parseBytes('1.5GB')).toBe(1.5 * 1024 ** 3)
    expect(parseBytes('10g')).toBe(10 * 1024 ** 3)
    expect(() => parseBytes('lots')).toThrow(/cannot read/)
  })
})

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('snapshot.maxBytes on srt (e2e, needs `npm run build`)', () => {
  it('drops the oldest rewind points first, keeping base, head and the last 10 steps', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-cap-')))
    const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), 'filesystem:\n  write: { allow: ["."] }\n')
    // An older session, then a branch that is abandoned in the current one.
    await envgit('run', 'sh', '-c', 'echo old > old.txt')
    expect((await envgit('session', 'new')).stdout).toMatch(/\S/)
    const current = (await readFile(join(dir, '.envgit', 'current'), 'utf8')).trim()
    await envgit('run', 'sh', '-c', 'echo 0 > n.txt')
    await envgit('run', 'sh', '-c', 'echo abandoned > n.txt')
    await envgit('rewind', '0')
    // Now the cap: every later step trips it.
    await writeFile(join(dir, '.envgit', 'policy.yaml'), 'filesystem:\n  write: { allow: ["."] }\nsnapshot:\n  maxBytes: 1\n')
    let last = { stderr: '' }
    for (let i = 1; i <= 13; i++) last = await envgit('run', 'sh', '-c', `echo ${i} > n.txt; echo ${i} > f${i}.txt`)
    expect(last.stderr).toMatch(/under snapshot.maxBytes .*still over the cap — base, head and the last 10 steps are kept/)

    const sessions = await readdir(join(dir, '.envgit', 'sessions'))
    const older = sessions.find(s => s !== current)!
    expect(JSON.parse(await readFile(join(dir, '.envgit', 'sessions', older, 'pruned'), 'utf8')).sort()).toEqual([0, 'base'])
    // Current session: the abandoned step 1, then its branch from the oldest on (steps 0, 2, 3, 4).
    const pruned = JSON.parse(await readFile(join(dir, '.envgit', 'sessions', current, 'pruned'), 'utf8')) as number[]
    expect(pruned.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])

    const log = (await envgit('log')).stdout
    expect(log).toMatch(/^ {4}0 .* pruned {2}/m)
    expect(log).toMatch(/^ {3}14 .* exit 0 {3}[0-9a-f]{8}/m)
    expect((await envgit('rewind', '3')).stderr).toMatch(/step 3 can no longer be restored: its snapshot was dropped to stay under snapshot.maxBytes/)
    expect((await envgit('rewind', '5')).stderr).toMatch(/rewound to step 5/)
    expect(await readFile(join(dir, 'n.txt'), 'utf8')).toBe('4\n')
    expect((await envgit('rewind', 'base')).stderr).toMatch(/rewound to base/)
    expect((await envgit('gc')).stdout).toMatch(/removed \d+ snapshot/)
  }, 120_000)
})
