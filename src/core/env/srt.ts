/** srt backend: OS-primitive sandbox via @anthropic-ai/sandbox-runtime. See docs/design.md §3.1 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { SandboxManager, type SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { compileSrt } from '../policy/compile.js'
import type { Gate } from '../policy/gate.js'
import type { Command, Effect, Env, EnvBackend, EnvSpec, ExecResult, SnapshotId } from './backend.js'

const MAX_CAPTURE = 1 << 20

export function shellQuote(argv: string[]): string {
  return argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

export class SrtBackend implements EnvBackend {
  readonly name = 'srt'
  private env?: Env & { workdir: string; snapshots?: EnvSpec['snapshots'] }
  private gate?: Gate

  async create(spec: EnvSpec): Promise<Env> {
    if (this.env) throw new Error('srt: only one env per process')
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(`srt: sandboxing is not supported on ${process.platform}`)
    }
    this.gate = spec.gate
    await SandboxManager.initialize(compileSrt(spec.policy ?? {}, spec.gate), undefined, true)
    if (!SandboxManager.isSandboxingEnabled()) throw new Error('srt: sandbox failed to initialize')
    this.env = { id: randomUUID(), backend: this.name, workdir: spec.workdir, snapshots: spec.snapshots }
    return this.env
  }

  /** fs-level only: the workdir, not memory or processes. */
  async snapshot(env: Env): Promise<SnapshotId> {
    const { workdir, snapshots } = this.current(env)
    return snapshots.store.snapshot(workdir, snapshots.exclude)
  }

  async restore(id: SnapshotId): Promise<Env> {
    const env = this.current(this.env)
    await env.snapshots.store.restore(env.workdir, id, env.snapshots.exclude)
    return env
  }

  private current(env: Env | undefined) {
    if (!env || env !== this.env) throw new Error('srt: unknown env')
    if (!this.env.snapshots) throw new Error('srt: env was created without a snapshot store')
    return this.env as typeof this.env & { snapshots: NonNullable<EnvSpec['snapshots']> }
  }

  async spawn(env: Env, cmd: Command, stdio: StdioOptions, signal?: AbortSignal): Promise<{ child: ChildProcess; commandId: string }> {
    if (env !== this.env) throw new Error('srt: unknown env')
    const commandId = randomBytes(16).toString('base64url')
    const commandText = shellQuote(cmd.argv)
    const cwd = cmd.cwd ?? this.env.workdir
    const wrapped = await SandboxManager.wrapWithSandboxArgv(commandText, undefined, undefined, signal, cwd, {
      commandId,
      commandText,
    })
    const [file, ...args] = wrapped.argv
    if (!file) throw new Error('srt: empty wrapped command')
    // Node's fetch ignores HTTP(S)_PROXY unless told to, and in the sandbox the proxy is the only way out.
    const child = spawn(file, args, { cwd, env: { NODE_USE_ENV_PROXY: '1', ...wrapped.env, ...cmd.env }, stdio })
    return { child, commandId }
  }

  /** Only denials are observable here; allowed connections and fs access are not surfaced by srt. */
  violations(commandId: string): SandboxViolationEvent[] {
    return SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId)
  }

  /**
   * Requests the gate judged since the last call. The gate is process-wide, so this attributes them to
   * whatever ran in between — one step at a time, which the busy lock guarantees.
   */
  gated(): Effect[] {
    return this.gate?.drain() ?? []
  }

  get waitingForApproval(): boolean {
    return this.gate?.waitingForApproval ?? false
  }

  async exec(env: Env, cmd: Command, signal?: AbortSignal): Promise<ExecResult> {
    const { child, commandId } = await this.spawn(env, cmd, ['inherit', 'pipe', 'pipe'], signal)
    try {
      const { exitCode, stdout, stderr } = await wait(child, signal)
      return { exitCode, stdout, stderr, effects: [...this.gated(), ...this.violations(commandId).map(toEffect)] }
    } finally {
      SandboxManager.cleanupAfterCommand()
    }
  }

  async destroy(env: Env): Promise<void> {
    if (env !== this.env) return
    this.env = undefined
    await SandboxManager.reset()
  }
}

export function toEffect(v: SandboxViolationEvent): Effect {
  return { kind: 'policy', denied: true, reason: v.line }
}

function wait(child: ChildProcess, signal?: AbortSignal) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const out = capture(child.stdout!, process.stdout)
    const err = capture(child.stderr!, process.stderr)
    const onAbort = () => child.kill('SIGINT')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code ?? 128 + signalNumber(sig), stdout: out(), stderr: err() })
    })
  })
}

function capture(stream: NodeJS.ReadableStream, tee: NodeJS.WritableStream): () => string {
  const chunks: Buffer[] = []
  let size = 0
  stream.on('data', (b: Buffer) => {
    tee.write(b)
    if (size < MAX_CAPTURE) chunks.push(b.subarray(0, MAX_CAPTURE - size))
    size += b.length
  })
  return () => Buffer.concat(chunks).toString('utf8')
}

function signalNumber(sig: NodeJS.Signals | null): number {
  const n = sig ? (os.constants.signals as Record<string, number>)[sig] : undefined
  return n ?? 0
}
