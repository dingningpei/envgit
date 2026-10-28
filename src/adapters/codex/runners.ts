/** Where the Codex adapter's commands run and how its steps are recorded: srt on the host, or the vm guest. */
import { basename, relative } from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { Effect, Env } from '../../core/env/backend.js'
import { SrtBackend, toEffect } from '../../core/env/srt.js'
import { L2_NET_ENV } from '../../core/env/vm-egress.js'
import { recordVmStep, withEgress } from '../../core/env/vm-step.js'
import { tarFrom, type VmBackend } from '../../core/env/vm.js'
import type { Egress } from '../../core/env/vm-egress.js'
import type { Gate } from '../../core/policy/gate.js'
import type { Policy } from '../../core/policy/schema.js'
import { ensureBase, recordStep, type OpenSession, type Snapshotting, type Step } from '../../core/snapshot/log.js'

/** This CLI, for running its helpers inside the sandbox. */
const CLI = fileURLToPath(new URL('../../cli/index.js', import.meta.url))

/** The http helper for the guest (it has node 24, not envgit): buffered, the body as base64. */
const GUEST_HTTP = `
const http = require('node:http')
const req = JSON.parse(Buffer.from(process.env.ENVGIT_HTTP_REQUEST, 'base64').toString())
const headers = (req.headers ?? []).map(h => [h.name, h.valueEnvVar ? h.value + (process.env[h.valueEnvVar] ?? '') : h.value])
const signal = req.timeoutMs != null ? AbortSignal.timeout(req.timeoutMs) : undefined
// As http-helper.ts: https by fetch (CONNECT + TLS, judged), http as an ordinary proxied request.
const viaProxy = (method, url, body) => new Promise((resolve, reject) => {
  const p = new URL(process.env.HTTP_PROXY), t = new URL(url)
  const auth = p.username ? [['proxy-authorization', 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64')]] : []
  const q = http.request({ host: p.hostname, port: Number(p.port) || 80, method, path: t.href, agent: new http.Agent(), signal,
    headers: [...headers.filter(([n]) => n.toLowerCase() !== 'host'), ['host', t.host], ...auth].flat() }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
      const out = []; for (let i = 0; i < res.rawHeaders.length; i += 2) out.push({ name: res.rawHeaders[i].toLowerCase(), value: res.rawHeaders[i + 1] })
      resolve({ status: res.statusCode, headers: out, body: Buffer.concat(chunks) }) }) })
  q.on('error', reject); q.end(body)
})
const viaFetch = async (method, url, body) => {
  const r = await fetch(url, { method, headers, ...(body && { body }), redirect: 'manual', ...(signal && { signal }) })
  const out = []; r.headers.forEach((value, name) => out.push({ name, value }))
  return { status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) }
}
;(async () => {
  let method = req.method, url = req.url, body = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined, res
  for (let hop = 0; ; hop++) {
    res = new URL(url).protocol === 'http:' ? await viaProxy(method, url, body) : await viaFetch(method, url, body)
    const loc = res.headers.find(h => h.name === 'location')?.value
    if (req.redirectPolicy === 'stop' || !loc || res.status < 300 || res.status > 399 || hop >= 5) break
    url = new URL(loc, url).href
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
  }
  process.stdout.write(JSON.stringify({ status: res.status, headers: res.headers, bodyBase64: res.body.toString('base64') }))
})().catch(e => { process.stderr.write(String(e && e.cause ? e.message + ': ' + e.cause.message : e)); process.exit(1) })
`

/** Splits the helper's output: one JSON line of status and headers, then the body as it streams. */
async function readHelper(out: NodeJS.ReadableStream, failure: () => Promise<string>): Promise<HttpResponse> {
  const it = (out as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  let buf = Buffer.alloc(0)
  for (;;) {
    const nl = buf.indexOf(10)
    if (nl >= 0) {
      const head = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { status: number; headers: { name: string; value: string }[] }
      const rest = buf.subarray(nl + 1)
      const body = (async function* () {
        if (rest.length) yield rest
        for (let r = await it.next(); !r.done; r = await it.next()) yield r.value as Buffer
      })()
      return { ...head, body }
    }
    const r = await it.next()
    if (r.done) throw new Error((await failure()).trim() || 'the request got no response')
    buf = Buffer.concat([buf, r.value as Buffer])
  }
}

export type StepFields = Omit<Step, 'index' | 'parent' | 'snapshot'>
export type FsOp = { op: 'write' | 'delete'; path: string }

/** One command as Codex asked for it: argv, a host cwd, and `process/start`'s envPolicy / env. */
export interface CommandSpec {
  argv: string[]
  cwd: string
  params: { tty?: boolean; pipeStdin?: boolean; envPolicy?: { inherit?: string; exclude?: string[]; set?: Record<string, string>; includeOnly?: string[] }; env?: Record<string, string> }
}

export interface RunHandle {
  kill(signal: NodeJS.Signals): void
  /** Bytes for the command's stdin; false when it has none (not asked for, closed, or the runner cannot). */
  write(data: Buffer): boolean
  done: Promise<{ exitCode: number; effects: Effect[] }>
}

/** One of Codex's `http/request`s, as the helper takes it (see http-helper.ts). */
export interface HttpRequest {
  method: string
  url: string
  headers?: { name: string; value: string; valueEnvVar?: string }[]
  bodyBase64?: string
  timeoutMs?: number | null
  redirectPolicy?: 'follow' | 'stop'
}

export interface HttpResponse {
  status: number
  headers: { name: string; value: string }[]
  body: AsyncIterable<Buffer>
}

export interface Runner {
  readonly sandboxType: string
  /** Codex's executor-side HTTP, made where its commands run: through the proxy and the gate. */
  httpRequest(req: HttpRequest): Promise<HttpResponse>
  readonly session: OpenSession
  /** Makes the real exec-server's environment info describe where commands actually run. */
  adjustInfo(info: any): void
  run(cmd: CommandSpec, onOutput: (stream: 'stdout' | 'stderr', data: Buffer) => void): Promise<RunHandle>
  /** Rewrites a forwarded request's paths from where commands run to the host, where fs calls run. */
  mapParams?(params: unknown): unknown
  /** Brings file operations Codex made on the host into the environment (before they are recorded). */
  applyFs(ops: FsOp[]): Promise<void>
  record(step: StepFields): Promise<void>
  close(): Promise<void>
}

interface Common {
  workdir: string
  policy: Policy
  gate: Gate
  snapshotting: Snapshotting
  log?: (line: string) => void
}

/** srt: commands run on the host in srt's sandbox; the workdir is the environment, so fs ops are already in it. */
export class SrtRunner implements Runner {
  readonly sandboxType = process.platform === 'darwin' ? 'macosSeatbelt' : 'linuxSeccomp'
  private backend = new SrtBackend()
  private env!: Env
  private prependPath: string[] = []
  private running = 0

  private constructor(
    private readonly o: Common,
    readonly session: OpenSession,
  ) {}

  /** `ensureBase` snapshots the workdir, so the caller holds the busy lock. */
  static async create(o: Common, session: OpenSession): Promise<SrtRunner> {
    const r = new SrtRunner(o, session)
    await ensureBase(session, o.snapshotting)
    r.env = await r.backend.create({ workdir: o.workdir, policy: o.policy, snapshots: o.snapshotting, gate: o.gate })
    return r
  }

  adjustInfo(info: any): void {
    this.prependPath = (info?.prependPathDirs ?? []).map((u: string) => fileURLToPath(u))
  }

  async run(cmd: CommandSpec, onOutput: (stream: 'stdout' | 'stderr', data: Buffer) => void): Promise<RunHandle> {
    // No PTY (that needs a native module): a `tty` command gets a stdin pipe instead, so Codex's
    // write_stdin reaches it, though the program does not see a terminal.
    const interactive = Boolean(cmd.params.tty || cmd.params.pipeStdin)
    const { child, commandId } = await this.backend.spawn(this.env, { argv: cmd.argv, cwd: cmd.cwd, env: this.childEnv(cmd.params) }, [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'])
    child.stdin?.on('error', () => {})
    this.running++
    child.stdout!.on('data', (d: Buffer) => onOutput('stdout', d))
    child.stderr!.on('data', (d: Buffer) => onOutput('stderr', d))
    const done = new Promise<{ exitCode: number; effects: Effect[] }>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, sig) => {
        const effects = [...this.backend.gated(), ...this.backend.violations(commandId).map(toEffect)]
        // Process-wide in srt (Linux bwrap mount points), so only once no other command runs.
        if (--this.running === 0) SandboxManager.cleanupAfterCommand()
        resolve({ exitCode: code ?? 128 + ((sig && (os.constants.signals as Record<string, number>)[sig]) || 0), effects })
      })
    })
    const write = (data: Buffer): boolean => {
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false
      // On a terminal these are keys, not bytes: ^C interrupts and ^D ends the input.
      if (cmd.params.tty && data.length === 1 && data[0] === 0x03) return child.kill('SIGINT'), true
      if (cmd.params.tty && data.length === 1 && data[0] === 0x04) return stdin.end(), true
      stdin.write(data)
      return true
    }
    return { kill: sig => child.kill(sig), write, done }
  }

  /** As the real server builds it: the policy over envgit's own environment, then the explicit variables. */
  private childEnv(p: CommandSpec['params']): Record<string, string> {
    const pol = p.envPolicy ?? {}
    let base: Record<string, string> = {}
    if (pol.inherit !== 'none') for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
    for (const k of pol.exclude ?? []) delete base[k]
    if (pol.includeOnly?.length) base = Object.fromEntries(Object.entries(base).filter(([k]) => pol.includeOnly!.includes(k)))
    const env = { ...base, ...(pol.set ?? {}), ...(p.env ?? {}) }
    if (this.prependPath.length) env.PATH = [...this.prependPath, env.PATH ?? ''].filter(Boolean).join(':')
    return env
  }

  async applyFs(): Promise<void> {}

  async httpRequest(req: HttpRequest): Promise<HttpResponse> {
    // srt exempts loopback from its proxy (NO_PROXY, set on the wrapped command line, so cleared the
    // same way): Codex's requests to a local MCP server must meet the gate too. Bundled roots plus srt's
    // CA (NODE_EXTRA_CA_CERTS): reading the macOS system store needs trustd, which the sandbox does not reach.
    const argv = ['/usr/bin/env', 'NO_PROXY=', 'no_proxy=', process.execPath, '--use-bundled-ca', CLI, 'codex-http-helper']
    const { child } = await this.backend.spawn(this.env, { argv, cwd: this.o.workdir }, ['pipe', 'pipe', 'pipe'])
    this.running++
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => (stderr += d))
    child.on('close', () => {
      if (--this.running === 0) SandboxManager.cleanupAfterCommand()
    })
    child.stdin!.end(JSON.stringify(req))
    return readHelper(child.stdout!, () => new Promise(r => (child.exitCode !== null ? r(stderr) : child.on('close', () => r(stderr)))))
  }

  async record(step: StepFields): Promise<void> {
    await recordStep(this.session, this.o.snapshotting, step)
  }

  async close(): Promise<void> {
    await this.backend.destroy(this.env)
  }
}

/**
 * vm: commands run in L2 with /work as the workdir; the host workdir is its mirror, synced after every
 * step. Codex's fs calls still go to the host (the mirror is current), and its writes are pushed into
 * the guest, like `envgit vm push`. One command at a time: L2's exec returns only when it ends.
 */
export class VmRunner implements Runner {
  readonly sandboxType = 'none'
  private chain: Promise<unknown> = Promise.resolve()
  /** One proxy for the whole Codex run (srt's per-host certificates stay cached); the tunnel opens per step. */
  private keep: { egress?: Egress } = {}

  constructor(
    private readonly o: Common,
    readonly session: OpenSession,
    private readonly vm: VmBackend,
  ) {}

  adjustInfo(info: any): void {
    if (!info) return
    // The guest is Ubuntu with bash and no zsh; Codex picks its shell from this.
    info.shell = { name: 'bash', path: '/bin/bash' }
    info.platformOs = 'linux'
    // Host directories (Codex's own helpers) do not exist in the guest.
    info.prependPathDirs = []
  }

  async run(cmd: CommandSpec, onOutput: (stream: 'stdout' | 'stderr', data: Buffer) => void): Promise<RunHandle> {
    const argv = [...cmd.argv]
    if (/^(z|k)sh$/.test(basename(argv[0]!))) argv[0] = '/bin/bash'
    // Not the host's environment: Codex's explicit variables over L2's defaults.
    const env = { ...(cmd.params.envPolicy?.set ?? {}), ...(cmd.params.env ?? {}), ...(this.o.policy.network?.allow?.length ? L2_NET_ENV : {}) }
    // L2's exec has no cwd; cd in a wrapper that then execs the command itself.
    const wrapped = ['/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'envgit-cd', this.guestPath(cmd.cwd), ...argv]
    const done = this.chain.then(async () => {
      const { result, effects } = await withEgress(this.o.workdir, this.o.policy, this.o.gate, this.vm, () => this.vm.exec({ id: '', backend: 'vm' }, { argv: wrapped, env }, undefined, { quiet: true }), this.keep)
      if (result.stdout) onOutput('stdout', Buffer.from(result.stdout))
      if (result.stderr) onOutput('stderr', Buffer.from(result.stderr))
      return { exitCode: result.exitCode, effects: [...result.effects, ...effects] }
    })
    this.chain = done.catch(() => {})
    // L2's exec has no stdin, and a running guest command cannot be interrupted from here yet.
    return { kill: () => this.o.log?.('envgit: a command in the VM cannot be interrupted; it runs to its end (10 min limit)'), write: () => false, done }
  }

  /**
   * Codex sees `/work` in command output (`pwd`) and may then name files there; fs calls run on the
   * host, against the mirror, so `file:///work/…` becomes the host workdir.
   */
  mapParams(params: unknown): unknown {
    const host = pathToFileURL(this.o.workdir).href
    return JSON.parse(JSON.stringify(params ?? null).replace(/"file:\/\/\/work(?=[/"])/g, `"${host}`))
  }

  private guestPath(hostPath: string): string {
    const r = relative(this.o.workdir, hostPath)
    return r === '' ? '/work' : r.startsWith('..') ? '/work' : `/work/${r}`
  }

  /** After any command still running in the guest: pushes must not interleave with one. */
  /**
   * In the guest, behind its egress: the helper's logic inlined for the guest's node (no envgit there),
   * with the request in an environment variable (L2's exec has no stdin) and the body back as base64
   * (its output is text), so it arrives in one piece.
   */
  async httpRequest(req: HttpRequest): Promise<HttpResponse> {
    const done = this.chain.then(() =>
      withEgress(this.o.workdir, this.o.policy, this.o.gate, this.vm, () =>
        this.vm.exec(
          { id: '', backend: 'vm' },
          { argv: ['node', '-e', GUEST_HTTP], env: { ...L2_NET_ENV, ENVGIT_HTTP_REQUEST: Buffer.from(JSON.stringify(req)).toString('base64') } },
          undefined,
          { quiet: true },
        ),
      this.keep),
    )
    this.chain = done.catch(() => {})
    const { result } = await done
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `request failed (exit ${result.exitCode})`)
    const r = JSON.parse(result.stdout) as { status: number; headers: { name: string; value: string }[]; bodyBase64: string }
    const body = Buffer.from(r.bodyBase64, 'base64')
    return { status: r.status, headers: r.headers, body: (async function* () { if (body.length) yield body })() }
  }

  async applyFs(ops: FsOp[]): Promise<void> {
    const done = this.chain.then(() => this.push(ops))
    this.chain = done.catch(() => {})
    await done
  }

  private async push(ops: FsOp[]): Promise<void> {
    const inside = ops.filter(o => !o.path.startsWith('/'))
    for (const o of ops) if (o.path.startsWith('/')) this.o.log?.(`envgit: ${o.op} ${o.path} is outside the workdir; it stays on the host, not in the VM`)
    const last = new Map(inside.map(o => [o.path, o.op]))
    const writes = [...last].filter(([, op]) => op === 'write').map(([p]) => p)
    const deletes = [...last].filter(([, op]) => op === 'delete').map(([p]) => `/work/${p}`)
    if (deletes.length) await this.vm.exec({ id: '', backend: 'vm' }, { argv: ['rm', '-rf', '--', ...deletes] }, undefined, { quiet: true })
    if (writes.length) await this.vm.importTar(await tarFrom(this.o.workdir, writes))
  }

  async record(step: StepFields): Promise<void> {
    // The mirror sync reports what changed in /work; for pushed fs ops that is the same list again.
    const effects = step.action.type === 'fs' ? step.effects.filter(e => e.kind !== 'fs') : step.effects
    await recordVmStep(this.session, this.o.snapshotting, this.vm, { ...step, effects })
  }

  async close(): Promise<void> {
    await this.chain
    await this.keep.egress?.stop()
  }
}
