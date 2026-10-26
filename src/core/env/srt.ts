/** srt backend: OS-primitive sandbox via @anthropic-ai/sandbox-runtime. See docs/design.md §3.1 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { compileSrt } from '../policy/compile.js'
import type { Command, Effect, Env, EnvBackend, EnvSpec, ExecResult, SnapshotId } from './backend.js'

const MAX_CAPTURE = 1 << 20

export function shellQuote(argv: string[]): string {
  return argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

export class SrtBackend implements EnvBackend {
  readonly name = 'srt'
  private env?: Env & { workdir: string }

  async create(spec: EnvSpec): Promise<Env> {
    if (this.env) throw new Error('srt: only one env per process')
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(`srt: sandboxing is not supported on ${process.platform}`)
    }
    await SandboxManager.initialize(compileSrt(spec.policy ?? {}), undefined, true)
    if (!SandboxManager.isSandboxingEnabled()) throw new Error('srt: sandbox failed to initialize')
    this.env = { id: randomUUID(), backend: this.name, workdir: spec.workdir }
    return this.env
  }

  snapshot(): Promise<SnapshotId> {
    return Promise.reject(new Error('srt: snapshots are not supported'))
  }

  restore(): Promise<Env> {
    return Promise.reject(new Error('srt: snapshots are not supported'))
  }

  async exec(env: Env, cmd: Command, signal?: AbortSignal): Promise<ExecResult> {
    if (env !== this.env) throw new Error('srt: unknown env')
    const commandId = randomBytes(16).toString('base64url')
    const commandText = shellQuote(cmd.argv)
    const cwd = cmd.cwd ?? this.env.workdir
    const wrapped = await SandboxManager.wrapWithSandboxArgv(commandText, undefined, undefined, signal, cwd, {
      commandId,
      commandText,
    })
    try {
      const { exitCode, stdout, stderr } = await run(wrapped.argv, { ...wrapped.env, ...cmd.env }, cwd, signal)
      // Only denials are observable here; allowed connections and fs access are not surfaced by srt.
      const effects: Effect[] = SandboxManager.getSandboxViolationStore()
        .getViolationsForCommand(commandId)
        .map(v => ({ kind: 'policy', denied: true, reason: v.line }))
      return { exitCode, stdout, stderr, effects }
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

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const [file, ...args] = argv
    if (!file) return reject(new Error('srt: empty wrapped command'))
    const child = spawn(file, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] })
    const out = capture(child.stdout, process.stdout)
    const err = capture(child.stderr, process.stderr)
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
