/**
 * Irreversible-action gating (docs/design.md §4). Every HTTP request the sandbox makes goes through
 * srt's proxy, TLS-terminated when the policy has request-level rules, and is judged here:
 * `network.l7` denies what it does not list; an `irreversible` rule allows, denies, or asks a person.
 * Shell rules are checked the same way before a command starts.
 */
import type { FilterRequestCallback, RequestDecision } from '@anthropic-ai/sandbox-runtime'
import type { Effect } from '../env/backend.js'
import type { IrreversibleAction, Policy } from './schema.js'

export interface NetRequest {
  method: string
  host: string
  port: number
  /** Normalized origin-form path, without the query. */
  path: string
}

export type GateVerdict =
  | { action: 'pass' }
  | { action: 'deny'; reason: string }
  | { action: IrreversibleAction; rule: string }

/** `*` is one path segment (or, in a host, anything); `**` is any run of segments. */
function glob(pattern: string, kind: 'path' | 'host'): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') {
      re += kind === 'path' ? '[^/]*' : '.*'
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, kind === 'host' ? 'i' : '')
}

function hostMatches(pattern: string, host: string, port: number): boolean {
  const [h, p] = pattern.split(/:(?=\d+$)/)
  return glob(h!, 'host').test(host) && (p === undefined || Number(p) === port)
}

export function netRuleLabel(r: { host: string; method?: string; path?: string }): string {
  return ['net', r.method?.toUpperCase() ?? '*', r.host, r.path ?? '**'].join(' ')
}

export function judgeNet(policy: Policy, req: NetRequest): GateVerdict {
  const method = req.method.toUpperCase()
  for (const [host, rule] of Object.entries(policy.network?.l7 ?? {})) {
    if (!hostMatches(host, req.host, req.port)) continue
    const methodOk = !rule.methods || rule.methods.some(m => m.toUpperCase() === method)
    const pathOk = !rule.paths || rule.paths.some(p => glob(p, 'path').test(req.path))
    if (!methodOk || !pathOk) return { action: 'deny', reason: `envgit: ${method} ${req.host}${req.path} is not allowed by network.l7 for ${host}` }
  }
  for (const rule of policy.irreversible ?? []) {
    if (!('net' in rule)) continue
    const n = rule.net
    if (!hostMatches(n.host, req.host, req.port)) continue
    if (n.method && n.method.toUpperCase() !== method) continue
    if (n.path && !glob(n.path, 'path').test(req.path)) continue
    return { action: rule.action ?? 'ask', rule: netRuleLabel(n) }
  }
  return { action: 'pass' }
}

export function judgeShell(policy: Policy, argv: string[]): { action: IrreversibleAction; rule: string } | undefined {
  const cmds = [argv.join(' '), ...scriptCommands(argv)]
  for (const rule of policy.irreversible ?? []) {
    if (!('shell' in rule)) continue
    const hit = rule.shell.find(p => cmds.some(cmd => cmd === p || cmd.startsWith(p + ' ')))
    if (hit) return { action: rule.action ?? 'ask', rule: `shell: ${hit}` }
  }
  return undefined
}

/**
 * The simple commands of `sh -c '<script>'` (any sh/bash/zsh/dash, `-lc` too), which is how agents
 * such as Codex run everything. A best effort split on newlines, `;`, `&&`, `||` and `|`: quoting,
 * subshells and variables still get past it, so net rules remain what enforces.
 */
function scriptCommands(argv: string[]): string[] {
  const [sh, flag, script] = argv
  if (argv.length !== 3 || !sh || !/(^|\/)(ba|z|da)?sh$/.test(sh) || !flag || !/^-[a-z]*c[a-z]*$/.test(flag) || !script) return []
  return script
    .split(/\n|;|&&|\|\||\|/)
    .map(c => c.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

/** Whether the policy needs request-level inspection, and with it TLS termination. */
export function needsInspection(policy: Policy): boolean {
  return Object.keys(policy.network?.l7 ?? {}).length > 0 || (policy.irreversible ?? []).some(r => 'net' in r)
}

export interface ApprovalRequest {
  /** What is about to happen, e.g. `POST github.com/acme/app.git/git-receive-pack`. */
  action: string
  rule: string
}

/** Asks a person. Resolves true to let it through; anything else (false, a throw) denies. */
export type Approver = (req: ApprovalRequest) => Promise<boolean>

/** No one to ask: an `ask` rule denies, and the reason says how to allow it on purpose. */
export const noApprover: Approver = async () => false

export class Gate {
  private collected: Effect[] = []
  /** Approvals are asked one at a time; concurrent requests wait their turn. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly policy: Policy,
    private approver: Approver = noApprover,
    /** Completes "there is …" when no one can be asked. */
    private approverName = 'nobody to ask (not a terminal)',
  ) {}

  setApprover(approver: Approver, name: string): void {
    this.approver = approver
    this.approverName = name
  }

  /** Effects observed since the last drain: the step that just ran made them. */
  drain(): Effect[] {
    const out = this.collected
    this.collected = []
    return out
  }

  private asking = 0

  /** Whether a person is being asked right now; step timeouts should not count that time. */
  get waitingForApproval(): boolean {
    return this.asking > 0
  }

  private ask(req: ApprovalRequest): Promise<boolean> {
    this.asking++
    const next = this.queue.then(() => this.approver(req).then(ok => ok === true, () => false))
    this.queue = next
    return next.finally(() => this.asking--)
  }

  private denyReason(action: string, rule: string, asked: boolean): string {
    return asked
      ? `envgit: ${action} is irreversible (${rule}) and was not approved`
      : `envgit: ${action} is irreversible (${rule}) and needs approval, but there is ${this.approverName}; to allow it without asking, set \`action: allow\` on that rule in .envgit/policy.yaml`
  }

  readonly filterRequest: FilterRequestCallback = async (request, info) => {
    const url = new URL(request.url)
    const host = info?.target?.host ?? url.hostname
    const port = info?.target?.port ?? Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const target = info?.normalizedRequestTarget ?? url.pathname + url.search
    const path = target.split('?')[0] || '/'
    const req: NetRequest = { method: request.method, host, port, path }
    const v = judgeNet(this.policy, req)
    const effect = { kind: 'net', host, port, method: req.method, path } as const
    const action = `${req.method} ${host}${path}`
    let decision: RequestDecision
    if (v.action === 'pass') return { action: 'allow' }
    if (v.action === 'deny' && 'reason' in v) {
      this.collected.push({ ...effect, denied: true })
      return { action: 'deny', reason: v.reason, mark: 'envgit-l7' }
    }
    const rule = (v as { rule: string }).rule
    if (v.action === 'allow') {
      this.collected.push({ ...effect, irreversible: { rule, decision: 'allowed' } })
      decision = { action: 'allow' }
    } else if (v.action === 'deny') {
      this.collected.push({ ...effect, denied: true, irreversible: { rule, decision: 'denied' } })
      decision = { action: 'deny', reason: `envgit: ${action} is irreversible (${rule}) and the policy denies it`, mark: 'envgit-irreversible' }
    } else {
      const asked = this.approver !== noApprover
      const ok = asked && (await this.ask({ action, rule }))
      this.collected.push({ ...effect, ...(!ok && { denied: true }), irreversible: { rule, decision: ok ? 'approved' : 'denied' } })
      decision = ok ? { action: 'allow' } : { action: 'deny', reason: this.denyReason(action, rule, asked), mark: 'envgit-irreversible' }
    }
    return decision
  }

  /** Checks a command line before it starts. Returns why it may not run, or undefined to go ahead. */
  async checkShell(argv: string[]): Promise<{ refused?: string; irreversible?: string }> {
    const hit = judgeShell(this.policy, argv)
    if (!hit) return {}
    const action = argv.join(' ')
    if (hit.action === 'allow') return { irreversible: hit.rule }
    if (hit.action === 'deny') return { refused: `envgit: \`${action}\` is irreversible (${hit.rule}) and the policy denies it` }
    const asked = this.approver !== noApprover
    if (asked && (await this.ask({ action, rule: hit.rule }))) return { irreversible: hit.rule }
    return { refused: this.denyReason(`\`${action}\``, hit.rule, asked) }
  }
}

/** The step's irreversible marker: the first irreversible effect that actually went out. */
export function irreversibleOf(effects: Effect[]): string | undefined {
  for (const e of effects) {
    if (e.kind === 'net' && e.irreversible && e.irreversible.decision !== 'denied') {
      return `${e.irreversible.rule} (${e.method} ${e.host}${e.path ?? ''}, ${e.irreversible.decision})`
    }
  }
  return undefined
}
