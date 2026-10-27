import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '../src/core/snapshot/log.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const hasCodex = (() => {
  try {
    execFileSync('codex', ['exec-server', '--help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

// The Codex adapter on the vm backend: commands in L2, Codex's file writes pushed into it.
describe.skipIf(process.env.ENVGIT_VM_E2E !== '1' || !hasCodex)('envgit as Codex exec-server on the vm backend (e2e, ENVGIT_VM_E2E=1)', () => {
  let dir: string
  let child: ChildProcess
  let id = 0
  let buf = ''
  const waiting = new Map<number, (m: Msg) => void>()
  const notes: Msg[] = []
  const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  const call = (method: string, params: unknown) =>
    new Promise<Msg>(r => {
      const i = ++id
      waiting.set(i, r)
      child.stdin!.write(JSON.stringify({ id: i, method, params }) + '\n')
    })
  const uri = (p: string) => pathToFileURL(join(dir, p)).href
  const steps = async (): Promise<Step[]> => {
    const current = (await readFile(join(dir, '.envgit/current'), 'utf8')).trim()
    const text = await readFile(join(dir, '.envgit/sessions', current, 'steps.jsonl'), 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Step)
  }
  const start = async (pid: string, script: string, cwd = '') => {
    await call('process/start', { processId: pid, argv: ['/bin/zsh', '-lc', script], cwd: pathToFileURL(join(dir, cwd)).href, env: { LANG: 'C.UTF-8' }, tty: false })
    for (;;) {
      if (notes.some(m => m.method === 'process/closed' && m.params.processId === pid)) break
      await new Promise(r => setTimeout(r, 50))
    }
    const exited = notes.find(m => m.method === 'process/exited' && m.params.processId === pid)!
    const out = notes
      .filter(m => m.method === 'process/output' && m.params.processId === pid)
      .map(m => Buffer.from(m.params.chunk, 'base64').toString())
      .join('')
    return { exitCode: exited.params.exitCode as number, out }
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-vm-codex-')))
    await writeFile(join(dir, 'notes.txt'), 'original\n')
    await envgit('init')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'backend: vm\n')
    expect((await envgit('vm', 'up')).stderr).toMatch(/vm up in/)
    child = spawn(process.execPath, [CLI, 'codex-exec-server'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as Msg
        buf = buf.slice(i + 1)
        if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m)
        else notes.push(m)
      }
    })
  }, 180_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.stdin!.end()
      await new Promise(r => child.once('exit', r))
    }
    if (dir) await envgit('vm', 'down')
  }, 60_000)

  it('tells Codex the shell and OS of the guest', async () => {
    const r = await call('initialize', { clientName: 'codex-environment' })
    expect(r.result.environmentInfo).toMatchObject({ shell: { name: 'bash', path: '/bin/bash' }, platformOs: 'linux', prependPathDirs: [] })
    child.stdin!.write(JSON.stringify({ method: 'initialized', params: null }) + '\n')
  }, 30_000)

  it('runs commands in the guest, in the matching /work directory, as steps mirrored to the host', async () => {
    await call('fs/createDirectory', { path: uri('sub'), recursive: true, sandbox: null })
    const { exitCode, out } = await start('v1', 'uname -s; pwd; echo from-guest >> ../notes.txt', 'sub')
    expect(exitCode).toBe(0)
    expect(out).toBe('Linux\n/work/sub\n')
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('original\nfrom-guest\n')
    const last = (await steps()).at(-1)!
    expect(last.action.type).toBe('exec')
    expect(last.effects).toContainEqual({ kind: 'fs', op: 'write', path: 'notes.txt' })
  }, 60_000)

  it('reads /work paths (what Codex sees in the guest) from the host mirror', async () => {
    const meta = await call('fs/getMetadata', { path: 'file:///work/notes.txt', sandbox: null })
    expect(meta.result).toMatchObject({ isFile: true })
    const { out } = await start('v0', 'pwd', '')
    expect(out).toBe('/work\n')
  }, 60_000)

  it('pushes Codex file writes and removals into the guest as one step', async () => {
    const before = (await steps()).length
    await call('fs/writeFile', { path: 'file:///work/app.py', dataBase64: Buffer.from("print('patched in')\n").toString('base64'), sandbox: null })
    await call('fs/remove', { path: uri('notes.txt'), recursive: false, force: true, sandbox: null })
    const { out } = await start('v2', 'python3 app.py; test -e notes.txt && echo still-there || echo gone')
    expect(out).toBe('patched in\ngone\n')
    const [fsStep] = (await steps()).slice(before)
    expect(fsStep!.action.type).toBe('fs')
    expect(JSON.parse(fsStep!.action.input)).toEqual([
      { op: 'write', path: 'app.py' },
      { op: 'delete', path: 'notes.txt' },
    ])
    expect(fsStep!.effects).toEqual(expect.arrayContaining([{ kind: 'fs', op: 'write', path: 'app.py' }, { kind: 'fs', op: 'delete', path: 'notes.txt' }]))
  }, 60_000)

  it('rewinds the guest to before Codex\'s writes', async () => {
    const all = await steps()
    // The last one: the createDirectory before the first command was an fs step too.
    const fsStep = all.findLast(s => s.action.type === 'fs')!
    child.stdin!.end()
    await new Promise(r => child.once('exit', r))
    expect((await envgit('rewind', String(fsStep.index - 1))).stderr).toMatch(/rewound to step/)
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('original\nfrom-guest\n')
    await expect(readFile(join(dir, 'app.py'))).rejects.toThrow()
    expect((await envgit('run', 'ls')).stdout.split('\n')).not.toContain('app.py')
    expect(await readdir(join(dir, 'sub'))).toEqual([])
  }, 60_000)
})
