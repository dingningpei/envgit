import { execFile } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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

  it('has git, node and python in the guest', async () => {
    const r = await envgit('run', 'sh', '-c', 'git --version; node -v; npm -v; python3 --version')
    expect(r.stdout).toMatch(/^git version 2\.\d+.*\nv24\.\d+\.\d+\n\d+\.\d+\.\d+\nPython 3\.\d+/s)
  }, 120_000)

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

  it('reaches the network only through the host proxy and gate, and only during a step', async () => {
    const hits: string[] = []
    const server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('from host')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const policy = await readFile(join(dir, '.envgit/policy.yaml'), 'utf8')
    await writeFile(
      join(dir, '.envgit/policy.yaml'),
      `backend: vm
network:
  allow: ["127.0.0.1"]
  l7:
    "127.0.0.1": { paths: ["/ok", "/deploy", "/bg"] }
irreversible:
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
`,
    )
    // In L2, loopback is L2's own; --noproxy '' sends a host-loopback URL through the proxy.
    const curl = (...a: string[]) => envgit('run', 'curl', '-s', '--noproxy', '', ...a)
    try {
      expect((await curl(`${base}/ok`)).stdout).toBe('from host')
      const deploy = await curl('-X', 'POST', `${base}/deploy`)
      expect(deploy.stdout).toMatch(/^envgit: POST 127\.0\.0\.1\/deploy is irreversible .*needs approval/)
      expect(deploy.stderr).toMatch(/denied POST 127\.0\.0\.1\/deploy/)
      expect((await curl(`${base}/admin`)).stdout).toMatch(/not allowed by network.l7/)
      expect(hits).toEqual(['GET /ok'])

      await envgit('run', 'sh', '-c', `(sleep 2; curl -s --noproxy '' ${base}/bg > bg.txt 2>&1) >/dev/null 2>&1 &`)
      await sleep(3500)
      expect((await envgit('run', 'cat', 'bg.txt')).stdout).toMatch(/^envgit: the sandbox has network access only while a step runs/)
      expect(hits).not.toContain('GET /bg')
    } finally {
      await writeFile(join(dir, '.envgit/policy.yaml'), policy)
      server.close()
    }
  }, 120_000)

  it('restarts a VM booted from an older build onto a checkpoint, losing nothing', async () => {
    await envgit('run', 'sh', '-c', 'echo before > restart.txt')
    const before = Number((await envgit('run', 'cat', 'counter')).stdout)
    await sleep(2000)
    // As if scripts/vm/build.sh had run since this VM booted.
    await writeFile(join(dir, '.envgit/vm/helper.stamp'), 'an-older-build\n')
    const r = await envgit('run', 'cat', 'counter')
    expect(r.stderr).toMatch(/restarted the VM on the current build/)
    // The checkpoint caught the counter's progress since the last step, and the loop still runs.
    expect(Number(r.stdout)).toBeGreaterThan(before)
    expect((await envgit('log')).stdout).toMatch(/ckpt {2}exit 0 .*before restarting the VM/)
    expect((await envgit('run', 'cat', 'restart.txt')).stdout).toBe('before\n')
    expect((await envgit('vm', 'up')).stderr).toMatch(/already running/)
  }, 120_000)

  it('does not resume a session on L2 images it was not taken on', async () => {
    const id = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const metaPath = join(dir, '.envgit/sessions', id, 'session.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    await writeFile(metaPath, JSON.stringify({ ...meta, vmImage: 'an-older-image' }))
    expect((await envgit('rewind', 'base')).stderr).toMatch(/taken on other L2 images/)
    await envgit('vm', 'down')
    const up = await envgit('vm', 'up')
    expect(up.stderr).toMatch(/taken on other L2 images .*starting a new session/s)
    expect((await readFile(join(dir, '.envgit/current'), 'utf8')).trim()).not.toBe(id)
  }, 120_000)
})
