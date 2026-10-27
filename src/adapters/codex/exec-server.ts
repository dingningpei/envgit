/**
 * Codex's environment, served by envgit (docs/design.md §3.4). Codex (0.162.1; the upstream
 * `codex exec-server` is marked experimental) sends every command and file operation to an
 * "exec-server" over JSON-RPC. envgit stands in as that server:
 *
 *   process/*   run by envgit's backend, in its sandbox and behind its gate; each process is a step
 *   fs mutators forwarded to a real `codex exec-server`, then recorded as one step per burst
 *   the rest    (reads, metadata, config, discovery) forwarded unchanged
 *
 * Step boundaries follow the capture of a real `codex exec`: one non-PTY `process/start` per shell
 * tool call, apply_patch as `fs/writeFile`s. A step is recorded before Codex hears that it ended.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { Effect, Env } from '../../core/env/backend.js'
import { SrtBackend, toEffect } from '../../core/env/srt.js'
import { irreversibleOf, type Gate } from '../../core/policy/gate.js'
import type { Policy } from '../../core/policy/schema.js'
import { acquireBusy, ensureBase, openSession, recordStep, releaseBusy, type OpenSession, type Snapshotting } from '../../core/snapshot/log.js'

type Id = number | string
interface Msg {
  id?: Id
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

/** Mutating fs methods: forwarded, then recorded. Everything not listed and not process/* is forwarded as is. */
const FS_MUTATORS: Record<string, (p: any) => { op: 'write' | 'delete'; uri: string }[]> = {
  'fs/writeFile': p => [{ op: 'write', uri: p.path }],
  'fs/createDirectory': p => [{ op: 'write', uri: p.path }],
  'fs/remove': p => [{ op: 'delete', uri: p.path }],
  'fs/copy': p => [{ op: 'write', uri: p.destinationPath }],
}
/** Capabilities envgit does not serve: without them Codex writes whole files and launches no proxy of its own. */
const UNSERVED_CAPABILITIES = ['fileWriteStreaming', 'sandboxedFileStreaming', 'networkProxyLaunch', 'shellSnapshotV2']
/** A burst of fs writes (one apply_patch) ends after this much quiet, or when a command starts. */
const FS_QUIET_MS = 150
const MAX_BUFFERED = 8 << 20

interface Proc {
  child: ChildProcess
  seq: number
  chunks: { seq: number; stream: 'stdout' | 'stderr'; chunk: string }[]
  buffered: number
  /** Set once envgit has recorded the step, so a read never reports an exit Codex could act on early. */
  exitCode?: number
  ended: boolean
  closed: boolean
  failure?: string
  waiters: (() => void)[]
}

export interface CodexExecServerOptions {
  workdir: string
  policy: Policy
  gate: Gate
  /** Delivers one JSON-RPC message to Codex. */
  send: (text: string) => void
  root: string
  snapshotting: Snapshotting
  codexBin?: string
  log?: (line: string) => void
}

export class CodexExecServer {
  private upstream?: ChildProcess
  private upId = 0
  private pendingUp = new Map<number, (m: Msg) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private procs = new Map<string, Proc>()
  private backend = new SrtBackend()
  private env?: Env
  private session?: OpenSession
  private prependPath: string[] = []
  private fsBurst?: { startedAt: string; ops: { op: 'write' | 'delete'; path: string }[]; timer?: NodeJS.Timeout }
  private holds = 0
  private recording: Promise<unknown> = Promise.resolve()
  /** The first initialize's answer; a reconnecting Codex gets it again (the upstream is initialized once). */
  private initResult?: unknown
  private initializedSent = false
  private closing = false

  constructor(private readonly o: CodexExecServerOptions) {}

  async start(): Promise<void> {
    const up = spawn(this.o.codexBin ?? 'codex', ['exec-server', '--listen', 'stdio'], { cwd: this.o.workdir, stdio: ['pipe', 'pipe', 'inherit'] })
    this.upstream = up
    await new Promise<void>((resolve, reject) => (up.once('spawn', resolve), up.once('error', reject)))
    let buf = ''
    up.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) this.fromUpstream(JSON.parse(line) as Msg)
      }
    })
    up.on('exit', () => {
      for (const done of this.pendingUp.values()) done({ error: { code: -32603, message: 'envgit: codex exec-server exited' } })
      this.pendingUp.clear()
    })
    this.session = await openSession(this.o.root, this.backend.name)
    await this.hold()
    try {
      await ensureBase(this.session, this.o.snapshotting)
    } finally {
      await this.release()
    }
    this.env = await this.backend.create({ workdir: this.o.workdir, policy: this.o.policy, snapshots: this.o.snapshotting, gate: this.o.gate })
  }

  /** One message from Codex. Requests are handled one at a time, as the real server does by default. */
  handle(text: string): void {
    const m = JSON.parse(text) as Msg
    this.queue = this.queue.then(() =>
      this.dispatch(m).catch(e => {
        const message = `envgit: ${e instanceof Error ? e.message : e}`
        // A request that fails here (e.g. another envgit holds the busy lock) still gets an answer.
        if (m.id !== undefined && m.method) this.fail(m.id, -32603, message)
        else this.o.log?.(message)
      }),
    )
  }

  /** Steps are appended one at a time: commands may end together, or while an fs burst is recorded. */
  private record(...args: Parameters<typeof recordStep>): Promise<unknown> {
    const next = this.recording.then(() => recordStep(...args))
    this.recording = next.catch(() => {})
    return next
  }

  private async whenClosed(p: Proc): Promise<void> {
    while (!p.closed) await new Promise<void>(r => p.waiters.push(r))
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const p of this.procs.values()) if (!p.closed) p.child.kill('SIGTERM')
    await this.queue
    await Promise.all([...this.procs.values()].map(p => this.whenClosed(p)))
    await this.flushFs()
    this.upstream?.stdin?.end()
    this.upstream?.kill()
    if (this.env) await this.backend.destroy(this.env)
  }

  private reply(id: Id | undefined, result: unknown): void {
    if (id !== undefined) this.o.send(JSON.stringify({ id, result }))
  }

  private fail(id: Id | undefined, code: number, message: string): void {
    if (id !== undefined) this.o.send(JSON.stringify({ id, error: { code, message } }))
  }

  private notify(method: string, params: unknown): void {
    this.o.send(JSON.stringify({ method, params }))
  }

  private async dispatch(m: Msg): Promise<void> {
    if (!m.method) return
    switch (m.method) {
      case 'initialize':
        return this.initialize(m)
      case 'initialized':
        if (this.initializedSent) return
        this.initializedSent = true
        break
      case 'process/start':
        await this.flushFs()
        return this.processStart(m)
      case 'process/read':
        return this.processRead(m)
      case 'process/write':
        return this.reply(m.id, { status: this.procs.has(m.params?.processId) ? 'stdinClosed' : 'unknownProcess' })
      case 'process/signal':
      case 'process/terminate': {
        const p = this.procs.get(m.params?.processId)
        const running = !!p && p.exitCode === undefined
        if (running) p.child.kill(m.method === 'process/signal' ? 'SIGINT' : 'SIGTERM')
        return this.reply(m.id, m.method === 'process/signal' ? {} : { running })
      }
    }
    const mutator = FS_MUTATORS[m.method]
    if (mutator) {
      if (!this.fsBurst) {
        await this.hold()
        this.fsBurst = { startedAt: new Date().toISOString(), ops: [] }
      }
      clearTimeout(this.fsBurst.timer)
      const r = await this.forward(m)
      if (!r.error) for (const { op, uri } of mutator(m.params)) this.fsBurst.ops.push({ op, path: this.rel(uri) })
      this.fsBurst.timer = setTimeout(() => {
        this.queue = this.queue.then(() => this.flushFs()).catch(e => this.o.log?.(`envgit: recording file writes failed: ${e instanceof Error ? e.message : e}`))
      }, FS_QUIET_MS)
      return
    }
    await this.forward(m)
  }

  /** The real server's answer, minus what envgit does not serve. */
  private async initialize(m: Msg): Promise<void> {
    if (this.initResult) return this.reply(m.id, this.initResult)
    const r = await this.call(m)
    if (r.error) return this.fail(m.id, r.error.code, r.error.message)
    const info = r.result?.environmentInfo
    if (info?.capabilities) for (const c of UNSERVED_CAPABILITIES) info.capabilities[c] = false
    this.prependPath = (info?.prependPathDirs ?? []).map((u: string) => fileURLToPath(u))
    this.initResult = r.result
    this.reply(m.id, r.result)
  }

  private async processStart(m: Msg): Promise<void> {
    const p = m.params ?? {}
    const id = String(p.processId ?? '')
    const argv: string[] = p.argv ?? []
    if (!id || !argv.length) return this.fail(m.id, -32602, 'processId and a non-empty argv are required')
    if (this.procs.has(id)) return this.fail(m.id, -32600, `process ${id} already exists`)
    if (!this.env) return this.fail(m.id, -32603, 'envgit: not started')
    const startedAt = new Date().toISOString()
    const shell = await this.o.gate.checkShell(argv)
    await this.hold()
    const cwd = p.cwd ? fileURLToPath(p.cwd) : this.o.workdir
    let child: ChildProcess, commandId: string
    try {
      ;({ child, commandId } = await this.backend.spawn(this.env, { argv: shell.refused ? ['/bin/sh', '-c', 'printf "%s\\n" "$1" >&2; exit 126', 'envgit', shell.refused] : argv, cwd, env: this.childEnv(p) }, ['ignore', 'pipe', 'pipe']))
    } catch (e) {
      await this.release()
      return this.fail(m.id, -32603, `envgit: could not start ${argv[0]}: ${e instanceof Error ? e.message : e}`)
    }
    const proc: Proc = { child, seq: 0, chunks: [], buffered: 0, ended: false, closed: false, waiters: [] }
    this.procs.set(id, proc)
    this.reply(m.id, { processId: id, sandboxType: process.platform === 'darwin' ? 'macosSeatbelt' : 'linuxSeccomp' })
    const wake = () => proc.waiters.splice(0).forEach(w => w())
    const out = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      const chunk = d.toString('base64')
      const seq = ++proc.seq
      if (proc.buffered < MAX_BUFFERED) (proc.chunks.push({ seq, stream, chunk }), (proc.buffered += d.length))
      this.notify('process/output', { processId: id, seq, stream, chunk })
      wake()
    }
    child.stdout!.on('data', out('stdout'))
    child.stderr!.on('data', out('stderr'))
    child.on('error', e => (proc.failure = e.message))
    child.on('close', (code, sig) => {
      const exitCode = code ?? 128 + ((sig && (os.constants.signals as Record<string, number>)[sig]) || 0)
      const effects: Effect[] = [
        ...(shell.refused ? [{ kind: 'policy', denied: true, reason: shell.refused } as const] : []),
        ...this.backend.gated(),
        ...this.backend.violations(commandId).map(toEffect),
      ]
      proc.ended = true
      // Process-wide in srt (Linux bwrap mount points), so only once no other command runs.
      if ([...this.procs.values()].every(q => q.ended)) SandboxManager.cleanupAfterCommand()
      const irreversible = shell.irreversible ?? irreversibleOf(effects)
      // Recorded before Codex hears of the exit: its next request may already depend on this step.
      void this.record(this.session!, this.o.snapshotting, {
        startedAt,
        endedAt: new Date().toISOString(),
        action: { type: 'exec', input: JSON.stringify(argv) },
        exitCode,
        effects,
        ...(irreversible && { irreversible: { reason: irreversible } }),
        ...(p.metadata?.toolCallId && { codex: { toolCallId: String(p.metadata.toolCallId) } }),
      })
        .catch(e => this.o.log?.(`envgit codex: recording the step failed: ${e instanceof Error ? e.message : e}`))
        .finally(async () => {
          await this.release()
          proc.exitCode = exitCode
          this.notify('process/exited', { processId: id, seq: ++proc.seq, exitCode, sandboxDenied: false })
          proc.closed = true
          this.notify('process/closed', { processId: id, seq: ++proc.seq })
          wake()
        })
    })
  }

  private async processRead(m: Msg): Promise<void> {
    const p = m.params ?? {}
    const proc = this.procs.get(p.processId)
    if (!proc) return this.fail(m.id, -32600, `unknown process ${p.processId}`)
    const after = p.afterSeq ?? 0
    const ready = () => proc.closed || proc.chunks.some(c => c.seq > after)
    if (!ready() && p.waitMs) {
      await new Promise<void>(r => {
        const t = setTimeout(r, p.waitMs)
        proc.waiters.push(() => (clearTimeout(t), r()))
      })
    }
    let budget = p.maxBytes ?? Infinity
    const chunks = []
    for (const c of proc.chunks) {
      if (c.seq <= after) continue
      const n = Buffer.byteLength(c.chunk, 'base64')
      if (chunks.length && n > budget) break
      chunks.push(c)
      budget -= n
    }
    const nextSeq = chunks.length ? chunks.at(-1)!.seq + 1 : Math.max(after + 1, 1)
    this.reply(m.id, {
      chunks,
      nextSeq,
      exited: proc.exitCode !== undefined,
      exitCode: proc.exitCode ?? null,
      closed: proc.closed,
      failure: proc.failure ?? null,
      sandboxDenied: false,
    })
  }

  /** As the real server builds it: the policy over envgit's own environment, then the explicit variables. */
  private childEnv(p: any): Record<string, string> {
    const pol = p.envPolicy ?? {}
    let base: Record<string, string> = {}
    if (pol.inherit !== 'none') for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
    for (const k of pol.exclude ?? []) delete base[k]
    if (pol.includeOnly?.length) base = Object.fromEntries(Object.entries(base).filter(([k]) => pol.includeOnly.includes(k)))
    const env = { ...base, ...(pol.set ?? {}), ...(p.env ?? {}) }
    if (this.prependPath.length) env.PATH = [...this.prependPath, env.PATH ?? ''].filter(Boolean).join(':')
    return env
  }

  private async flushFs(): Promise<void> {
    const burst = this.fsBurst
    if (!burst) return
    this.fsBurst = undefined
    clearTimeout(burst.timer)
    try {
      if (!burst.ops.length) return
      await this.record(this.session!, this.o.snapshotting, {
        startedAt: burst.startedAt,
        endedAt: new Date().toISOString(),
        action: { type: 'fs', input: JSON.stringify(burst.ops) },
        exitCode: 0,
        effects: burst.ops.map(o => ({ kind: 'fs', op: o.op, path: o.path })),
      })
    } finally {
      await this.release()
    }
  }

  /** The busy lock is per process; hold it while any command runs or fs writes are unrecorded. */
  private async hold(): Promise<void> {
    if (this.holds++ === 0) await acquireBusy(this.o.root).catch(e => ((this.holds = 0), Promise.reject(e)))
  }

  private async release(): Promise<void> {
    if (--this.holds === 0) await releaseBusy(this.o.root)
  }

  private rel(uri: string): string {
    const path = fileURLToPath(uri)
    const r = relative(this.o.workdir, path)
    return r.startsWith('..') ? path : r
  }

  private call(m: Msg): Promise<Msg> {
    const id = ++this.upId
    return new Promise(resolve => {
      this.pendingUp.set(id, resolve)
      this.upstream!.stdin!.write(JSON.stringify({ ...m, id }) + '\n')
    })
  }

  private async forward(m: Msg): Promise<Msg> {
    if (m.id === undefined) {
      this.upstream!.stdin!.write(JSON.stringify(m) + '\n')
      return {}
    }
    const r = await this.call(m)
    this.o.send(JSON.stringify(r.error ? { id: m.id, error: r.error } : { id: m.id, result: r.result }))
    return r
  }

  private fromUpstream(m: Msg): void {
    if (m.id !== undefined && !m.method) {
      const done = this.pendingUp.get(Number(m.id))
      this.pendingUp.delete(Number(m.id))
      done?.(m)
      return
    }
    // The upstream runs no processes for Codex, so its notifications are rare; pass them on.
    if (m.id === undefined) this.o.send(JSON.stringify(m))
  }
}
