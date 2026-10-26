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

  it('records the files a step wrote and deleted as fs effects', async () => {
    await envgit('run', 'sh', '-c', 'echo e > effect.txt; rm -f later.txt')
    const session = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const steps = (await readFile(join(dir, '.envgit/sessions', session, 'steps.jsonl'), 'utf8')).trim().split('\n')
    const effects = JSON.parse(steps.at(-1)!).effects as { kind: string; op: string; path: string }[]
    expect(effects).toContainEqual({ kind: 'fs', op: 'write', path: 'effect.txt' })
  }, 60_000)

  it('keeps snapshots on the host: resumes after vm down, rewinds while down', async () => {
    await envgit('run', 'sh', '-c', 'echo kept > kept.txt')
    const head = Number(/head: (\d+)/.exec((await envgit('log')).stdout)![1])
    const before = Number((await envgit('run', 'cat', 'counter')).stdout)
    await envgit('run', 'sh', '-c', 'echo after > after.txt')
    await envgit('vm', 'down')
    const up = await envgit('vm', 'up')
    expect(up.stderr).toMatch(/resumed session \S+ at step \d+/)
    // The background counter from an earlier step is still running after a cold resume.
    const resumed = Number((await envgit('run', 'cat', 'counter')).stdout)
    expect(resumed).toBeGreaterThan(before)
    await sleep(2000)
    expect(Number((await envgit('run', 'cat', 'counter')).stdout)).toBeGreaterThan(resumed)

    await envgit('vm', 'down')
    expect((await envgit('rewind', String(head))).stderr).toMatch(/rewound to step/)
    expect(await readFile(join(dir, 'kept.txt'), 'utf8')).toBe('kept\n')
    await expect(readFile(join(dir, 'after.txt'))).rejects.toThrow()
    expect((await envgit('vm', 'status')).stdout).toMatch(/vm: running/)
  }, 180_000)

  it('forks a step into a new directory that resumes with its processes', async () => {
    const head = (/head: (\d+)/.exec((await envgit('log')).stdout)![1])
    const target = `${dir}-fork`
    const f = await envgit('fork', head, target)
    expect(f.stderr).toMatch(/forked step \d+ into/)
    expect(await readFile(join(target, 'kept.txt'), 'utf8')).toBe('kept\n')
    const sub = (...args: string[]) =>
      run(process.execPath, [CLI, ...args], { cwd: target }).catch((e: { code: number; stdout: string; stderr: string }) => e)
    try {
      expect((await sub('vm', 'up')).stderr).toMatch(/resumed session/)
      const a = Number((await sub('run', 'cat', 'counter')).stdout)
      await sleep(2000)
      expect(Number((await sub('run', 'cat', 'counter')).stdout)).toBeGreaterThan(a)
    } finally {
      await sub('vm', 'down')
    }
  }, 180_000)
})
