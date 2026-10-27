import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

// On vm a step's memory is a diff on its parent's: pruning one folds it into its children.
describe.skipIf(process.env.ENVGIT_VM_E2E !== '1')('snapshot.maxBytes on the vm backend (e2e, ENVGIT_VM_E2E=1)', () => {
  let dir: string
  const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  afterAll(async () => {
    if (dir) await envgit('vm', 'down')
  }, 60_000)

  it('folds old diffs into their children, drops abandoned branches, and still restores what is kept', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-vm-cap-')))
    await envgit('init')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'backend: vm\n')
    expect((await envgit('vm', 'up')).stderr).toMatch(/vm up in/)
    // A background counter whose memory changes between steps, so every diff is non-trivial.
    await envgit('run', 'sh', '-c', '(i=0; while :; do i=$((i+1)); echo $i > counter; sleep 0.3; done) >/dev/null 2>&1 &')
    await envgit('run', 'sh', '-c', 'echo abandoned > branch.txt')
    await envgit('rewind', '0')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'backend: vm\nsnapshot:\n  maxBytes: 1\n')
    for (let i = 1; i <= 13; i++) await envgit('run', 'sh', '-c', `echo ${i} >> log.txt`)

    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const pruned = JSON.parse(await readFile(join(dir, '.envgit/sessions', current, 'pruned'), 'utf8')) as number[]
    // The abandoned step 1, and the branch's oldest: 0, 2, 3, 4 (14 on it, 10 kept).
    expect(pruned.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    const steps = (await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { index: number; snapshot: string })
    const snaps = (await readdir(join(dir, '.envgit/vm/snaps'))).filter(n => !n.startsWith('.'))
    for (const i of pruned) expect(snaps).not.toContain(steps[i]!.snapshot)
    // The oldest kept step now builds straight on the base.
    const meta = JSON.parse(await readFile(join(dir, '.envgit/vm/snaps', steps[5]!.snapshot, 'meta.json'), 'utf8')) as { parent: string }
    expect(meta.parent).toBe(JSON.parse(await readFile(join(dir, '.envgit/sessions', current, 'session.json'), 'utf8')).base)

    // Folded memory restores: files and the running counter.
    expect((await envgit('rewind', '5')).stderr).toMatch(/rewound to step 5/)
    expect(await readFile(join(dir, 'log.txt'), 'utf8')).toBe('1\n2\n3\n4\n')
    const a = Number((await envgit('run', 'cat', 'counter')).stdout)
    await new Promise(r => setTimeout(r, 1500))
    expect(Number((await envgit('run', 'cat', 'counter')).stdout)).toBeGreaterThan(a)
    expect((await envgit('rewind', '2')).stderr).toMatch(/can no longer be restored/)
  }, 300_000)
})
