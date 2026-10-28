import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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

const POLICY = `filesystem:
  read: { allow: ["."] }
  write: { allow: [".", "/tmp"] }
network:
  allow: ["127.0.0.1"]
irreversible:
  - shell: ["git push"]
    action: deny
  - net: { host: "127.0.0.1", method: POST, path: "/deploy" }
    action: deny
`

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

/** A scripted stand-in for Codex's harness, speaking the exec-server protocol as captured from `codex exec`. */
class Harness {
  private id = 0
  private buf = ''
  private waiting = new Map<number, (m: Msg) => void>()
  notes: Msg[] = []
  private onNote: (() => void)[] = []
  constructor(private child: ChildProcess) {
    child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i)) as Msg
        this.buf = this.buf.slice(i + 1)
        if (m.id !== undefined && !m.method) this.waiting.get(m.id)?.(m)
        else (this.notes.push(m), this.onNote.splice(0).forEach(f => f()))
      }
    })
  }
  call(method: string, params: unknown): Promise<Msg> {
    const id = ++this.id
    this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
    return new Promise(r => this.waiting.set(id, r))
  }
  notify(method: string, params: unknown): void {
    this.child.stdin!.write(JSON.stringify({ method, params }) + '\n')
  }
  async until(pred: (m: Msg) => boolean): Promise<Msg> {
    for (;;) {
      const hit = this.notes.find(pred)
      if (hit) return hit
      await new Promise<void>(r => this.onNote.push(r))
    }
  }
}

describe.skipIf(!hasCodex || (process.platform !== 'darwin' && process.platform !== 'linux'))('envgit as Codex exec-server (e2e, needs `codex` and `npm run build`)', () => {
  let dir: string
  let child: ChildProcess
  let h: Harness
  let seen = 0
  const uri = (p: string) => pathToFileURL(join(dir, p)).href
  const steps = async (): Promise<Step[]> => {
    const sessions = join(dir, '.envgit', 'sessions')
    const [id] = await readdir(sessions)
    const text = await readFile(join(sessions, id!, 'steps.jsonl'), 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Step)
  }
  const start = async (pid: string, script: string) => {
    const r = await h.call('process/start', {
      processId: pid,
      metadata: { toolCallId: `call-${pid}` },
      argv: ['/bin/sh', '-lc', script],
      cwd: pathToFileURL(dir).href,
      envPolicy: { inherit: 'all', exclude: [], set: {}, includeOnly: [] },
      env: { LANG: 'C.UTF-8' },
      tty: false,
      pipeStdin: false,
      arg0: null,
    })
    // The step must be on disk by the time Codex hears the process exited.
    const exited = await h.until(m => m.method === 'process/exited' && m.params.processId === pid)
    const recorded = await steps()
    await h.until(m => m.method === 'process/closed' && m.params.processId === pid)
    const out = h.notes
      .filter(m => m.method === 'process/output' && m.params.processId === pid)
      .map(m => Buffer.from(m.params.chunk, 'base64').toString())
      .join('')
    return { r, exitCode: exited.params.exitCode as number, out, recorded }
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-codex-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), POLICY)
    await writeFile(join(dir, 'notes.txt'), 'hello\n')
    child = spawn(process.execPath, [CLI, 'codex-exec-server'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
    h = new Harness(child)
  }, 30_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.stdin!.end()
      await new Promise(r => child.once('exit', r))
    }
  })

  it('answers initialize with the real executor info, minus what envgit does not serve', async () => {
    const r = await h.call('initialize', { clientName: 'codex-environment', resumeSessionId: null })
    expect(r.result.environmentInfo.cwd).toBe(pathToFileURL(dir).href)
    expect(r.result.environmentInfo.capabilities).toMatchObject({ fileWriteStreaming: false, networkProxyLaunch: false, shellSnapshotV2: false })
    h.notify('initialized', null)
    // Reads are forwarded to the real exec-server.
    const meta = await h.call('fs/getMetadata', { path: uri('notes.txt'), sandbox: null })
    expect(meta.result).toMatchObject({ isFile: true })
    const missing = await h.call('fs/getMetadata', { path: uri('.git'), sandbox: null })
    expect(missing.error?.code).toBeDefined()
  }, 30_000)

  it('runs each command in the sandbox as a step, recorded before Codex hears it ended', async () => {
    const { r, exitCode, out, recorded } = await start('p1', "printf '%s\\n' world >> notes.txt\ncat notes.txt")
    expect(r.result.processId).toBe('p1')
    expect(exitCode).toBe(0)
    expect(out).toBe('hello\nworld\n')
    const last = recorded.at(-1)!
    expect(JSON.parse(last.action.input)).toEqual(['/bin/sh', '-lc', "printf '%s\\n' world >> notes.txt\ncat notes.txt"])
    expect(last.codex).toEqual({ toolCallId: 'call-p1' })
    seen = recorded.length
    // A late read still gets the buffered output and the terminal state.
    const read = await h.call('process/read', { processId: 'p1', afterSeq: null, maxBytes: 65536, waitMs: 0 })
    expect(read.result).toMatchObject({ exited: true, exitCode: 0, closed: true })
    expect(Buffer.from(read.result.chunks[0].chunk, 'base64').toString()).toMatch(/^hello/)
    expect((await h.call('process/terminate', { processId: 'p1' })).result).toEqual({ running: false })
  }, 30_000)

  it('records a burst of file writes (apply_patch) as one step, before the next command', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    expect((await h.call('fs/createDirectory', { path: uri('src'), recursive: true, sandbox: null })).error).toBeUndefined()
    expect((await h.call('fs/writeFile', { path: uri('src/app.py'), dataBase64: b64("print('hi')\n"), sandbox: null })).error).toBeUndefined()
    expect((await h.call('fs/writeFile', { path: uri('notes.txt'), dataBase64: b64('patched\n'), sandbox: null })).error).toBeUndefined()
    const { out, recorded } = await start('p2', 'cat notes.txt src/app.py')
    expect(out).toBe("patched\nprint('hi')\n")
    const [fsStep, execStep] = recorded.slice(seen)
    expect(fsStep!.action.type).toBe('fs')
    expect(fsStep!.effects).toEqual([
      { kind: 'fs', op: 'write', path: 'src' },
      { kind: 'fs', op: 'write', path: 'src/app.py' },
      { kind: 'fs', op: 'write', path: 'notes.txt' },
    ])
    expect(execStep!.action.type).toBe('exec')
    seen = recorded.length
  }, 30_000)

  it('passes process/write to an interactive command, ^C as an interrupt', async () => {
    const begin = (pid: string, script: string, extra: object) =>
      h.call('process/start', { processId: pid, argv: ['/bin/sh', '-lc', script], cwd: pathToFileURL(dir).href, env: {}, ...extra })
    const write = (pid: string, s: string) => h.call('process/write', { processId: pid, chunk: Buffer.from(s).toString('base64'), writeId: pid + s.length })
    const exited = (pid: string) => h.until(m => m.method === 'process/exited' && m.params.processId === pid)
    const output = (pid: string) =>
      h.notes.filter(m => m.method === 'process/output' && m.params.processId === pid).map(m => Buffer.from(m.params.chunk, 'base64').toString()).join('')

    await begin('i1', 'read a; echo "got:$a"', { tty: true })
    expect((await write('i1', 'hello\n')).result).toEqual({ status: 'accepted' })
    expect((await exited('i1')).params.exitCode).toBe(0)
    expect(output('i1')).toBe('got:hello\n')
    expect((await write('i1', 'late\n')).result).toEqual({ status: 'stdinClosed' })

    await begin('i2', 'sleep 30', { tty: true })
    await write('i2', '\x03')
    expect((await exited('i2')).params.exitCode).toBe(130)

    await begin('i3', 'sleep 0.2', { tty: false, pipeStdin: false })
    expect((await write('i3', 'x')).result).toEqual({ status: 'stdinClosed' })
    await exited('i3')
    expect((await write('nope', 'x')).result).toEqual({ status: 'unknownProcess' })
    seen = (await steps()).length
  }, 30_000)

  it('refuses commands an irreversible shell rule denies, even inside the shell script', async () => {
    const { exitCode, out } = await start('p3', 'git status >/dev/null 2>&1; git push origin main')
    expect(exitCode).toBe(126)
    expect(out).toMatch(/irreversible \(shell: git push\) and the policy denies it/)
  }, 30_000)

  it('answers with an error, not silence, when another envgit is running a step here', async () => {
    // The test runner stands in for that other envgit: a live pid that is not the server's.
    await writeFile(join(dir, '.envgit', 'busy'), JSON.stringify({ pid: process.pid }))
    try {
      const r = await h.call('process/start', { processId: 'p4', argv: ['/bin/sh', '-lc', 'true'], cwd: pathToFileURL(dir).href, env: {}, tty: false })
      expect(r.error?.message).toMatch(/another envgit process \(pid \d+\) is running a step here/)
    } finally {
      await rm(join(dir, '.envgit', 'busy'))
    }
  }, 30_000)

  it('makes Codex\'s http/request through the proxy and the gate, not around them', async () => {
    const hits: string[] = []
    const server = http.createServer((q, r) => (hits.push(`${q.method} ${q.url}`), r.end('from host')))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const get = await h.call('http/request', { method: 'GET', url: `${base}/ok`, headers: [], requestId: 'r1', streamResponse: false })
      expect(get.error).toBeUndefined()
      expect(get.result.status).toBe(200)
      expect(Buffer.from(get.result.bodyBase64, 'base64').toString()).toBe('from host')

      const streamed = await h.call('http/request', { method: 'GET', url: `${base}/stream`, headers: [], requestId: 'r2', streamResponse: true })
      expect(streamed.result).toMatchObject({ status: 200, bodyBase64: '' })
      await h.until(m => m.method === 'http/request/bodyDelta' && m.params.requestId === 'r2' && m.params.done)
      const body = h.notes.filter(m => m.method === 'http/request/bodyDelta' && m.params.requestId === 'r2').map(m => Buffer.from(m.params.deltaBase64, 'base64').toString()).join('')
      expect(body).toBe('from host')

      const deploy = await h.call('http/request', { method: 'POST', url: `${base}/deploy`, headers: [], bodyBase64: Buffer.from('{}').toString('base64'), requestId: 'r3' })
      expect(deploy.result.status).toBe(403)
      expect(Buffer.from(deploy.result.bodyBase64, 'base64').toString()).toMatch(/envgit: POST 127\.0\.0\.1\/deploy is irreversible .*policy denies it/)
      expect(hits).toEqual(['GET /ok', 'GET /stream'])
      // The gate's decision lands on the next step.
      await start('h1', 'true')
      const last = (await steps()).at(-1)!
      expect(last.effects).toContainEqual(expect.objectContaining({ kind: 'net', method: 'POST', path: '/deploy', denied: true }))
      seen = (await steps()).length
    } finally {
      server.close()
    }
  }, 60_000)

  it('rewinds Codex steps like any other', async () => {
    const all = await steps()
    const fsStep = all.find(s => s.action.type === 'fs')!
    child.stdin!.end()
    await new Promise(r => child.once('exit', r))
    const log = (await run(process.execPath, [CLI, 'log'], { cwd: dir })).stdout
    expect(log).toMatch(/fs {4}exit 0 .*write src, write src\/app\.py, write notes\.txt/)
    expect(log).toMatch(/exec {2}exit 0 .*\/bin\/sh -lc printf '%s\\n' world >> notes\.txt cat notes\.txt/)
    await run(process.execPath, [CLI, 'rewind', String(fsStep.index - 1)], { cwd: dir })
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('hello\nworld\n')
    await expect(readFile(join(dir, 'src/app.py'))).rejects.toThrow()
  }, 30_000)
})

/** Stands in for Codex: connects to CODEX_EXEC_SERVER_URL as the real client does and runs one command. */
const FAKE_AGENT = `
const url = process.env.CODEX_EXEC_SERVER_URL
const bad = new WebSocket(url.replace(/\\/[^/]*$/, '/wrong'))
const refused = await new Promise(r => { bad.onopen = () => r(false); bad.onerror = () => r(true) })
const ws = new WebSocket(url)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const waiting = new Map()
let out = ''
let closed
const done = new Promise(r => (closed = r))
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined && !m.method) return waiting.get(m.id)(m)
  if (m.method === 'process/output') out += Buffer.from(m.params.chunk, 'base64').toString()
  if (m.method === 'process/closed') closed()
}
const call = (method, params) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await call('initialize', { clientName: 'codex-environment' })
ws.send(JSON.stringify({ method: 'initialized', params: null }))
await call('process/start', { processId: 'a1', argv: ['/bin/sh', '-lc', 'echo via-ws > ws.txt; cat ws.txt'], cwd: 'file://' + process.cwd(), envPolicy: { inherit: 'all' }, env: {}, tty: false, pipeStdin: false, arg0: null })
await done
console.log(JSON.stringify({ refused, out, args: process.argv.slice(2) }))
// As real Codex does: exit without a close frame (envgit used to hang on that).
process.exit(0)
`

describe.skipIf(!hasCodex || (process.platform !== 'darwin' && process.platform !== 'linux'))('envgit codex (e2e, WebSocket)', () => {
  it('runs the agent with CODEX_EXEC_SERVER_URL on a secret loopback path, its commands as steps', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-codex-ws-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), POLICY)
    await writeFile(join(dir, 'agent.mjs'), FAKE_AGENT)
    const r = await run(process.execPath, [CLI, 'codex', 'exec', 'hi'], {
      cwd: dir,
      env: { ...process.env, ENVGIT_CODEX_AGENT: JSON.stringify([process.execPath, join(dir, 'agent.mjs')]) },
    })
    expect(JSON.parse(r.stdout)).toEqual({ refused: true, out: 'via-ws\n', args: ['exec', 'hi'] })
    expect(r.stderr).toMatch(/Codex ran in session \S+/)
    const log = (await run(process.execPath, [CLI, 'log'], { cwd: dir })).stdout
    expect(log).toMatch(/exec {2}exit 0 .*echo via-ws > ws\.txt; cat ws\.txt/)
  }, 30_000)
})
