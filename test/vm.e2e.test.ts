import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

// Boots the nested-Firecracker VM: needs scripts/vm/build.sh, an M3+ Mac on macOS 15+, and opt-in.
describe.skipIf(process.env.ENVGIT_VM_E2E !== '1')('vm backend (e2e, ENVGIT_VM_E2E=1)', () => {
  let dir: string
  const envgit = (...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-vm-')))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'notes.txt'), 'original\n')
    await writeFile(join(dir, 'src/app.py'), "print('hi from L2')\n")
    await envgit('init')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'backend: vm\n')
    const up = await envgit('vm', 'up')
    expect(up.stderr).toMatch(/vm up in/)
  }, 180_000)

  afterAll(async () => {
    if (dir) await envgit('vm', 'down')
  }, 60_000)

  it('runs commands in the guest on files imported from the host', async () => {
    const r = await envgit('run', 'sh', '-c', 'cat notes.txt; python3 src/app.py')
    expect(r.stdout).toBe('original\nhi from L2\n')
  }, 60_000)

  it('rewinds files and a running process together', async () => {
    await envgit('run', 'sh', '-c', '(i=0; while :; do i=$((i+1)); echo $i > counter; sleep 1; done) >/dev/null 2>&1 &')
    await sleep(3000)
    const atStep = Number((await envgit('run', 'cat', 'counter')).stdout)
    const log1 = (await envgit('log')).stdout
    const stepOfCount = Number(/head: (\d+)/.exec(log1)![1])
    await envgit('run', 'sh', '-c', 'echo later > later.txt; rm notes.txt')
    await sleep(2000)
    expect(await readFile(join(dir, 'later.txt'), 'utf8')).toBe('later\n')
    await expect(readFile(join(dir, 'notes.txt'))).rejects.toThrow()

    expect((await envgit('rewind', String(stepOfCount))).stderr).toMatch(/rewound to step/)
    // Files: the host mirror is back to that step.
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('original\n')
    await expect(readFile(join(dir, 'later.txt'))).rejects.toThrow()
    // Process: the counter loop survived the rewind and continues from where it was.
    const right = Number((await envgit('run', 'cat', 'counter')).stdout)
    expect(right).toBeGreaterThanOrEqual(atStep)
    expect(right).toBeLessThan(atStep + 3)
    await sleep(2500)
    expect(Number((await envgit('run', 'cat', 'counter')).stdout)).toBeGreaterThan(right)
  }, 120_000)

  it('records host edits pushed into the guest as a step', async () => {
    await writeFile(join(dir, 'notes.txt'), 'edited on host\n')
    expect((await envgit('vm', 'push', 'notes.txt')).stderr).toMatch(/pushed 1 path\(s\) as step \d+/)
    expect((await envgit('run', 'cat', 'notes.txt')).stdout).toBe('edited on host\n')
    expect((await envgit('log')).stdout).toMatch(/push {2}exit 0 .*\["notes.txt"\]/)
  }, 60_000)
})
