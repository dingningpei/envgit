/** srt backend: OS-primitive sandbox via @anthropic-ai/sandbox-runtime. See docs/design.md §3.1 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxManager, type SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { compileSrt } from '../policy/compile.js'
import { needsInspection, type Gate } from '../policy/gate.js'
import type { Policy } from '../policy/schema.js'
import type { Command, Effect, Env, EnvBackend, EnvSpec, ExecResult, SnapshotId } from './backend.js'

const MAX_CAPTURE = 1 << 20
/**
 * Go (gh, github-mcp-server) on macOS verifies through the system's trust daemon, which the sandbox
 * denies, unless SSL_CERT_FILE names a bundle. srt sets it only when it terminates TLS; for an opaque
 * tunnel this points it at the system's own roots (not roots added to the keychain).
 */
const SYSTEM_ROOTS = process.platform === 'darwin' && existsSync('/etc/ssl/cert.pem') ? { SSL_CERT_FILE: '/etc/ssl/cert.pem' } : {}
/** Where the system's roots are as one PEM file, for a bundle that adds to them. */
const ROOT_BUNDLES = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt']

export function shellQuote(argv: string[]): string {
  return argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

export class SrtBackend implements EnvBackend {
  readonly name = 'srt'
  private env?: Env & { workdir: string; snapshots?: EnvSpec['snapshots'] }
  private gate?: Gate
  private trust?: { dir: string; env: NodeJS.ProcessEnv }

  async create(spec: EnvSpec): Promise<Env> {
    if (this.env) throw new Error('srt: only one env per process')
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(`srt: sandboxing is not supported on ${process.platform}`)
    }
    this.gate = spec.gate
    this.trust = await extraTrust(spec.policy ?? {}, spec.gate)
    await SandboxManager.initialize(compileSrt(spec.policy ?? {}, spec.gate, { extra: spec.srtExtra }), undefined, true)
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
    const childEnv: NodeJS.ProcessEnv = { NODE_USE_ENV_PROXY: '1', ...SYSTEM_ROOTS, ...this.trust?.env, ...wrapped.env, ...cmd.env }
    // Node 22–24 then warn, in every node process the command starts, that the proxy agent is
    // experimental (UNDICI-EHPA): envgit's setting, not the agent's, so not the agent's output.
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA'].filter(Boolean).join(' ')
    // The sandbox trusts srt's bundle, not the host's system store (on macOS unreachable: every node process would print the failures).
    delete childEnv.NODE_USE_SYSTEM_CA
    const child = spawn(file, args, { cwd, env: childEnv, stdio })
    return { child, commandId }
  }

  /** Only denials are observable here; allowed connections and fs access are not surfaced by srt. */
  violations(commandId: string): SandboxViolationEvent[] {
    return SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId).filter(notGated)
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
    if (this.trust) await rm(this.trust.dir, { recursive: true, force: true })
    this.trust = undefined
  }
}

/**
 * `network.extraCaCertPaths` when nothing is TLS-terminated: clients in the sandbox verify upstreams
 * themselves, so they get the system roots plus these (curl, git, Python, Go through the bundle; Node
 * through NODE_EXTRA_CA_CERTS, on top of its own roots). When the proxy terminates TLS the sandbox only
 * meets srt's CA, and the upstream is verified in envgit's own process, by the host's trust.
 */
async function extraTrust(policy: Policy, gate?: Gate): Promise<{ dir: string; env: NodeJS.ProcessEnv } | undefined> {
  const paths = policy.network?.extraCaCertPaths ?? []
  if (!paths.length || (gate && needsInspection(policy))) return undefined
  const certs: string[] = []
  for (const p of paths.map(p => p.replace(/^~(?=\/|$)/, os.homedir()))) {
    const pem = await readFile(p, 'utf8').catch(e => {
      throw new Error(`network.extraCaCertPaths: cannot read ${p} (${e.code ?? e})`)
    })
    // Certificates only: a private key in a combined PEM stays out of the sandbox.
    const found = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
    if (!found) throw new Error(`network.extraCaCertPaths: no PEM certificate in ${p}`)
    certs.push(...found)
  }
  const dir = await mkdtemp(join(os.tmpdir(), 'envgit-ca-'))
  const extra = join(dir, 'extra.pem')
  await writeFile(extra, certs.join('\n') + '\n')
  const env: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: extra }
  const roots = ROOT_BUNDLES.find(f => existsSync(f))
  if (roots) {
    const bundle = join(dir, 'bundle.pem')
    await writeFile(bundle, `${(await readFile(roots, 'utf8')).trimEnd()}\n${certs.join('\n')}\n`)
    for (const k of ['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO']) env[k] = bundle
  }
  return { dir, env }
}

/** srt also logs the gate's own denials; the gate already recorded them as `net` effects. */
export function notGated(v: SandboxViolationEvent): boolean {
  return !/^deny http-request \S+ \S+ \(envgit: /.test(v.line)
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
