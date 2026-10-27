/** Where the Codex adapter's commands run and how its steps are recorded: srt on the host, or the vm guest. */
import { basename, relative } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
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

export type StepFields = Omit<Step, 'index' | 'parent' | 'snapshot'>
export type FsOp = { op: 'write' | 'delete'; path: string }

/** One command as Codex asked for it: argv, a host cwd, and `process/start`'s envPolicy / env. */
export interface CommandSpec {
  argv: string[]
  cwd: string
  params: { envPolicy?: { inherit?: string; exclude?: string[]; set?: Record<string, string>; includeOnly?: string[] }; env?: Record<string, string> }
}

export interface RunHandle {
  kill(signal: NodeJS.Signals): void
  done: Promise<{ exitCode: number; effects: Effect[] }>
}

export interface Runner {
  readonly sandboxType: string
  readonly session: OpenSession
  /** Makes the real exec-server's environment info describe where commands actually run. */
  adjustInfo(info: any): void
  run(cmd: CommandSpec, onOutput: (stream: 'stdout' | 'stderr', data: Buffer) => void): Promise<RunHandle>
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
    const { child, commandId } = await this.backend.spawn(this.env, { argv: cmd.argv, cwd: cmd.cwd, env: this.childEnv(cmd.params) }, ['ignore', 'pipe', 'pipe'])
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
    return { kill: sig => child.kill(sig), done }
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
    // A running guest command cannot be interrupted from here yet.
    return { kill: () => this.o.log?.('envgit: a command in the VM cannot be interrupted; it runs to its end (10 min limit)'), done }
  }

  private guestPath(hostPath: string): string {
    const r = relative(this.o.workdir, hostPath)
    return r === '' ? '/work' : r.startsWith('..') ? '/work' : `/work/${r}`
  }

  /** After any command still running in the guest: pushes must not interleave with one. */
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
