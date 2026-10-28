/**
 * The REPL on the vm backend (docs/design.md §3.3, §3.6): the worker runs inside L2 as the agent's
 * child, so it lives in guest memory and every snapshot holds it. A rewind therefore brings the
 * REPL's variables back to that step instead of resetting them, which the srt backend cannot do.
 */
import { createHash } from 'node:crypto'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effect } from '../core/env/backend.js'
import { tarFrom, type VmBackend } from '../core/env/vm.js'
import { L2_NET_ENV, type Egress } from '../core/env/vm-egress.js'
import { recordVmStep, withEgress } from '../core/env/vm-step.js'
import { irreversibleOf, type Gate } from '../core/policy/gate.js'
import type { Policy } from '../core/policy/schema.js'
import { acquireBusy, ensureBase, readHead, releaseBusy, type OpenSession, type Snapshotting, type StepRef } from '../core/snapshot/log.js'
import type { Repl, ReplResult } from './session.js'
import { mcpServers } from '../core/policy/load.js'
import { CAPABILITIES_ENV, DESCRIBE, MCP_ENV, type Description, type WorkerMessage } from './worker.js'

const DEPS = ['core/env/proxied-fetch.js', 'core/mcp/client.js', 'core/mcp/declare.js']

/** envgit's worker as installed in L2: the compiled REPL modules (and what they import), acorn, and an entry point. */
async function workerBundle(): Promise<{ tar: Buffer; version: string }> {
  const here = dirname(fileURLToPath(import.meta.url))
  const acorn = dirname(dirname(createRequire(import.meta.url).resolve('acorn')))
  const stage = await mkdtemp(join(tmpdir(), 'envgit-worker-'))
  try {
    for (const f of ['worker.js', 'capabilities.js', 'engine.js', 'inspect.js']) await cp(join(here, f), join(stage, 'repl', f))
    // What capabilities.js imports: the REPL's fetch for plain HTTP through the proxy, the MCP client.
    for (const f of DEPS) await cp(join(here, '..', f), join(stage, f))
    await cp(join(acorn, 'package.json'), join(stage, 'node_modules/acorn/package.json'))
    await cp(join(acorn, 'dist'), join(stage, 'node_modules/acorn/dist'), { recursive: true })
    await writeFile(join(stage, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(stage, 'worker.mjs'), "import { runWorker } from './repl/worker.js'\nawait runWorker()\n")
    const h = createHash('sha256')
    for (const f of ['repl/worker.js', 'repl/capabilities.js', 'repl/engine.js', 'repl/inspect.js', ...DEPS, 'worker.mjs']) h.update(await readFile(join(stage, f)))
    const version = h.digest('hex').slice(0, 16)
    await writeFile(join(stage, 'VERSION'), version + '\n')
    return { tar: await tarFrom(stage), version }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export class VmReplSession implements Repl {
  private queue: Promise<unknown> = Promise.resolve()
  private lastHead?: StepRef
  private installed = false
  /** srt's proxy, kept between steps (the tunnel to L2 opens only during one). */
  private net: { egress?: Egress } = {}
  /** What the gate judged outside a step (MCP servers starting up), for the next step. */
  private carried: Effect[] = []

  constructor(
    private readonly vm: VmBackend,
    private readonly policy: Policy,
    private readonly session: OpenSession,
    private readonly snap: Snapshotting,
    private readonly gate: Gate,
    private readonly timeoutMs = 30_000,
  ) {}

  execute(code: string): Promise<ReplResult> {
    const run = this.queue.then(() => this.run(code))
    this.queue = run.catch(() => {})
    return run
  }

  describe(): Promise<Description> {
    const run = this.queue.then(async () => {
      const root = this.snap.store.root
      await acquireBusy(root)
      try {
        if (await access(join(root, 'restoring')).then(() => true, () => false)) {
          throw new Error('a rewind was interrupted here; run any envgit command (e.g. envgit log) to finish it')
        }
        await ensureBase(this.session, this.snap)
        if (!this.installed) {
          await this.install()
          this.installed = true
        }
        let reply: WorkerMessage | undefined
        const { effects } = await withEgress(this.snap.workdir, this.policy, this.gate, this.vm, async () => {
          reply = JSON.parse(await this.call(DESCRIBE, this.workerEnv())) as WorkerMessage
        }, this.net)
        this.carried.push(...effects)
        if (!reply || !('output' in reply)) throw new Error('REPL worker gave no description')
        if (reply.error) throw new Error(reply.error)
        return JSON.parse(reply.output) as Description
      } finally {
        await releaseBusy(root)
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** The worker's environment in L2; it applies when the worker starts. */
  private workerEnv(): Record<string, string> {
    return {
      [CAPABILITIES_ENV]: JSON.stringify(this.policy.capabilities ?? {}),
      [MCP_ENV]: JSON.stringify(mcpServers(this.policy)),
      ...(this.policy.network?.allow?.length && L2_NET_ENV),
    }
  }

  /** The worker belongs to the VM and outlives this process; only the host proxy is ours to stop. */
  async close(): Promise<void> {
    await this.net.egress?.stop()
    this.net = {}
  }

  private async run(code: string): Promise<ReplResult> {
    const root = this.snap.store.root
    await acquireBusy(root)
    try {
      if (await access(join(root, 'restoring')).then(() => true, () => false)) {
        throw new Error('a rewind was interrupted here; run any envgit command (e.g. envgit log) to finish it')
      }
      const notices: string[] = []
      const head = await readHead(this.session.dir)
      if (this.lastHead !== undefined && head !== this.lastHead) {
        notices.push(`[envgit] the environment was rewound to ${head === 'base' ? 'base' : `step ${head}`}; the REPL is back as it was then, variables included`)
      }
      if (!this.installed) {
        if (await this.install()) notices.push('[envgit] installed a new REPL worker in the VM; earlier REPL variables were reset')
        this.installed = true
      }
      const r = await this.step(code)
      this.lastHead = r.step
      return notices.length ? { ...r, output: notices.join('\n') + '\n' + r.output } : r
    } finally {
      await releaseBusy(root)
    }
  }

  /** Installs the worker unless L2 already has this version. Returns whether it replaced one. */
  private async install(): Promise<boolean> {
    const { tar, version } = await workerBundle()
    const current = await this.vm.exec({ id: '', backend: 'vm' }, { argv: ['cat', '/opt/envgit/VERSION'] }, undefined, { quiet: true }).catch(() => undefined)
    if (current?.exitCode === 0 && current.stdout.trim() === version) return false
    await this.vm.install(tar)
    return current?.exitCode === 0
  }

  private async step(code: string): Promise<ReplResult> {
    await ensureBase(this.session, this.snap)
    const startedAt = new Date().toISOString()
    const env = this.workerEnv()
    let output = ''
    let error: string | undefined
    let observed: Effect[] = []
    const { effects: net } = await withEgress(this.snap.workdir, this.policy, this.gate, this.vm, async () => {
      try {
        const reply = JSON.parse(await this.call(code, env)) as WorkerMessage
        if ('output' in reply) {
          output = reply.output
          error = reply.error
          observed = reply.effects
        }
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).replace(/^vm: /, '')
      }
    }, this.net)
    const effects = [...this.carried.splice(0), ...observed, ...net]
    const irreversible = irreversibleOf(effects)
    const { step } = await recordVmStep(this.session, this.snap, this.vm, {
      startedAt,
      endedAt: new Date().toISOString(),
      action: { type: 'repl', input: code },
      exitCode: error ? 1 : 0,
      effects,
      ...(irreversible && { irreversible: { reason: irreversible } }),
    })
    return { output, error, effects, step: step.index }
  }

  /**
   * One request to the worker. The timeout is kept here rather than in L2 so that time spent waiting
   * for a person to approve an irreversible request does not count; on expiry the worker is killed.
   */
  private async call(code: string, env: Record<string, string>): Promise<string> {
    const pending = this.vm.repl(code, env, 24 * 60 * 60_000)
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'expired'>(resolve => {
      const arm = () => (timer = setTimeout(() => (this.gate.waitingForApproval ? arm() : resolve('expired')), this.timeoutMs))
      arm()
    })
    try {
      const first = await Promise.race([pending, expired])
      if (first !== 'expired') return first
      await this.vm.replKill()
      await pending.catch(() => {})
      throw new Error(`timed out after ${this.timeoutMs}ms; REPL state was reset`)
    } finally {
      clearTimeout(timer)
    }
  }
}
