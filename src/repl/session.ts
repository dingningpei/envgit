/** Parent side of the REPL: owns the sandboxed worker, the policy and the action log. */
import type { ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { irreversibleOf } from '../core/policy/gate.js'
import type { Effect, Env } from '../core/env/backend.js'
import { toEffect, type SrtBackend } from '../core/env/srt.js'
import type { Policy } from '../core/policy/schema.js'
import { acquireBusy, ensureBase, readHead, recordStep, releaseBusy, type OpenSession, type Snapshotting, type StepRef } from '../core/snapshot/log.js'
import { mcpServers } from '../core/policy/load.js'
import { CAPABILITIES_ENV, DESCRIBE, MCP_ENV, type Description, type WorkerMessage, type WorkerRequest } from './worker.js'

export interface ReplResult {
  output: string
  error?: string
  effects: Effect[]
  step: number
}

/** What the MCP server drives: srt's ReplSession or the vm backend's VmReplSession. */
export interface Repl {
  execute(code: string): Promise<ReplResult>
  /** The injected API: starts the worker (and its MCP servers) if need be. Not a step. */
  describe(): Promise<Description>
  close(): Promise<void>
}

// The macOS violation log arrives asynchronously (and lossily); give it a moment before closing a step.
const SETTLE_MS = 250

interface Worker {
  child: ChildProcess
  commandId: string
  pending: Map<number, (m: WorkerMessage & { id: number }) => void>
  exited: Promise<void>
}

export class ReplSession implements Repl {
  private worker?: Worker
  private nextId = 0
  private claimed = new WeakSet<SandboxViolationEvent>()
  private queue: Promise<unknown> = Promise.resolve()
  /** Head after this session's last step; a different head on disk means someone rewound. */
  private lastHead?: StepRef

  constructor(
    private readonly backend: SrtBackend,
    private readonly env: Env,
    private readonly policy: Policy,
    private readonly session: OpenSession,
    private readonly snap: Snapshotting,
    private readonly timeoutMs = 30_000,
  ) {}

  execute(code: string): Promise<ReplResult> {
    const run = this.queue.then(() => this.run(code))
    this.queue = run.catch(() => {})
    return run
  }

  describe(): Promise<Description> {
    const run = this.queue.then(async () => {
      // The base first: an MCP server starting up may already write in the workdir.
      await acquireBusy(this.snap.store.root)
      try {
        await ensureBase(this.session, this.snap)
      } finally {
        await releaseBusy(this.snap.store.root)
      }
      const worker = await this.ensureWorker()
      const id = this.nextId++
      try {
        const reply = await Promise.race([
          new Promise<WorkerMessage & { id: number }>(resolve => {
            worker.pending.set(id, resolve)
            worker.child.stdin!.write(JSON.stringify({ id, code: DESCRIBE } satisfies WorkerRequest) + '\n')
          }),
          worker.exited.then(() => Promise.reject(new Error('REPL worker exited'))),
        ])
        if (!('output' in reply)) throw new Error('REPL worker gave no description')
        if (reply.error) throw new Error(reply.error)
        return JSON.parse(reply.output) as Description
      } finally {
        worker.pending.delete(id)
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  async close(): Promise<void> {
    const w = this.worker
    this.worker = undefined
    if (!w) return
    w.child.stdin?.end()
    w.child.kill()
    await w.exited
  }

  private async run(code: string): Promise<ReplResult> {
    await acquireBusy(this.snap.store.root)
    try {
      // A half-finished rewind must be completed (by the CLI) before a step runs on that tree.
      if (await access(join(this.snap.store.root, 'restoring')).then(() => true, () => false)) {
        throw new Error('a rewind was interrupted here; run any envgit command (e.g. envgit log) to finish it')
      }
      const head = await readHead(this.session.dir)
      let notice: string | undefined
      if (this.lastHead !== undefined && head !== this.lastHead) {
        await this.close()
        notice = `[envgit] the workdir was rewound to ${head === 'base' ? 'base' : `step ${head}`}; REPL variables were reset\n`
      }
      const r = await this.step(code)
      this.lastHead = r.step
      return notice ? { ...r, output: notice + r.output } : r
    } finally {
      await releaseBusy(this.snap.store.root)
    }
  }

  private async step(code: string): Promise<ReplResult> {
    await ensureBase(this.session, this.snap)
    const startedAt = new Date().toISOString()
    const worker = await this.ensureWorker()
    const id = this.nextId++
    let output = ''
    let error: string | undefined
    let observed: Effect[] = []
    let timer: NodeJS.Timeout | undefined
    try {
      const reply = await Promise.race([
        new Promise<WorkerMessage & { id: number }>(resolve => {
          worker.pending.set(id, resolve)
          worker.child.stdin!.write(JSON.stringify({ id, code } satisfies WorkerRequest) + '\n')
        }),
        new Promise<never>((_, reject) => {
          // Time spent waiting for a person to approve an irreversible request does not count.
          const arm = () =>
            (timer = setTimeout(() => (this.backend.waitingForApproval ? arm() : reject(new Error(`timed out after ${this.timeoutMs}ms; REPL state was reset`))), this.timeoutMs))
          arm()
        }),
        worker.exited.then(() => Promise.reject(new Error('REPL worker exited; REPL state was reset'))),
      ])
      if ('output' in reply) {
        output = reply.output
        error = reply.error
        observed = reply.effects
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      await this.close()
    } finally {
      clearTimeout(timer)
      worker.pending.delete(id)
    }

    // Best-effort supplement: catches denials no capability wrapper sees. Not deduplicated against `observed`.
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const effects = [
      ...observed,
      ...this.backend.gated(),
      ...this.backend
        .violations(worker.commandId)
        .filter(v => !this.claimed.has(v) && (this.claimed.add(v), true))
        .map(toEffect),
    ]
    const step = await recordStep(this.session, this.snap, {
      startedAt,
      endedAt: new Date().toISOString(),
      action: { type: 'repl', input: code },
      exitCode: error ? 1 : 0,
      effects,
      ...(irreversibleOf(effects) && { irreversible: { reason: irreversibleOf(effects)! } }),
    })
    return { output, error, effects, step: step.index }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    const argv = [process.execPath, ...process.execArgv, process.argv[1]!, 'mcp', '--worker']
    const { child, commandId } = await this.backend.spawn(
      this.env,
      {
        argv,
        env: { [CAPABILITIES_ENV]: JSON.stringify(this.policy.capabilities ?? {}), [MCP_ENV]: JSON.stringify(mcpServers(this.policy)), NODE_USE_ENV_PROXY: '1' },
      },
      ['pipe', 'pipe', 'pipe'],
    )
    child.stderr!.pipe(process.stderr)
    const pending: Worker['pending'] = new Map()
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      exited.then(() => reject(new Error('REPL worker exited during startup')))
      createInterface({ input: child.stdout! }).on('line', line => {
        let msg: WorkerMessage
        try {
          msg = JSON.parse(line) as WorkerMessage
        } catch {
          return
        }
        if ('ready' in msg) resolve()
        else pending.get(msg.id)?.(msg)
      })
    })
    const worker: Worker = { child, commandId, pending, exited }
    exited.then(() => {
      if (this.worker === worker) this.worker = undefined
    })
    await ready
    this.worker = worker
    return worker
  }
}
