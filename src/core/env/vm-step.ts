/** One step on the vm backend, shared by `envgit run` and the REPL (docs/design.md §3.6). */
import type { Gate } from '../policy/gate.js'
import type { Policy } from '../policy/schema.js'
import { recordStep, type OpenSession, type Snapshotting, type Step } from '../snapshot/log.js'
import type { Effect } from './backend.js'
import type { MirrorResult, VmBackend } from './vm.js'
import { startEgress, type Egress } from './vm-egress.js'

const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s)

/** Per kind, so a step like `npm install` does not put tens of thousands of paths in the log. */
const MAX_FS_EFFECTS = 1000

/** What the step did to /work, as seen by comparing the guest with the previous sync. */
export function mirrorEffects(m: MirrorResult): Effect[] {
  return [
    ...m.changed.slice(0, MAX_FS_EFFECTS).map(path => ({ kind: 'fs', op: 'write', path }) as const),
    ...m.deleted.slice(0, MAX_FS_EFFECTS).map(path => ({ kind: 'fs', op: 'delete', path }) as const),
  ]
}

export function reportMirror(m: MirrorResult): void {
  if (m.refused) console.error(red(`envgit: mirror refused ${m.refused} path(s) that would resolve outside the workdir`))
  if (m.conflicts.length) {
    const shown = m.conflicts.slice(0, 5).join(', ') + (m.conflicts.length > 5 ? `, … (${m.conflicts.length})` : '')
    console.error(red(`envgit: kept host edits not yet pushed to the VM: ${shown} — \`envgit vm push\` them, or delete them to take the VM's version`))
  }
}

/** Snapshots the guest first, so the mirror and the step's effects describe the recorded state. */
export async function recordVmStep(
  session: OpenSession,
  snap: Snapshotting,
  vm: VmBackend,
  partial: Omit<Step, 'index' | 'parent' | 'snapshot'>,
): Promise<{ step: Step; mirror: MirrorResult }> {
  const snapshot = await vm.snapshot()
  const m = await vm.syncMirror()
  reportMirror(m)
  const step = await recordStep(session, { ...snap, take: async () => snapshot }, { ...partial, effects: [...partial.effects, ...mirrorEffects(m)] })
  return { step, mirror: m }
}

/**
 * Runs `fn` with L2's egress open when the policy allows any host: the host proxy and gate serve the
 * tunnel, the L2 CA bundle is current, and the VM carries this step's proxy credentials. Returns
 * `fn`'s result and the network effects the gate and allowlist recorded meanwhile.
 *
 * With `keep`, the proxy outlives the step (only the tunnel closes) and is reused next time — a
 * long-lived caller such as `envgit mcp` then keeps srt's per-host certificate cache; it calls
 * `keep.egress?.stop()` when it is done.
 */
export async function withEgress<T>(
  workdir: string,
  policy: Policy,
  gate: Gate,
  vm: VmBackend,
  fn: () => Promise<T>,
  keep?: { egress?: Egress },
): Promise<{ result: T; effects: Effect[] }> {
  let egress = keep?.egress
  const started = new Date()
  try {
    if (policy.network?.allow?.length) {
      if (egress) await egress.open()
      else egress = await startEgress(workdir, policy, gate)
      if (keep) keep.egress = egress
      vm.proxyAuth = egress.proxyAuth
      await vm.trust(egress.ca)
    }
    const result = await fn()
    return { result, effects: [...gate.drain(), ...(egress?.denials(started) ?? [])] }
  } finally {
    vm.proxyAuth = undefined
    if (keep) await egress?.close()
    else await egress?.stop()
  }
}
