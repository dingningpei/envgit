/** Policy → srt settings. See docs/design.md §3.2 */
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { needsInspection, type Gate } from './gate.js'
import { join } from 'node:path'
import type { Policy } from './schema.js'

/**
 * With request-level rules (`network.l7`, `irreversible` net rules) and a gate to apply them, srt
 * terminates TLS with a per-run CA (trusted in the sandbox through the usual *_CA_BUNDLE variables)
 * and hands every request to the gate. Without such rules HTTPS stays an opaque, host-allowlisted tunnel.
 */
export function compileSrt(policy: Policy, gate?: Gate, opts: { ca?: { certPath: string; keyPath: string } } = {}): SandboxRuntimeConfig {
  const fs = policy.filesystem ?? {}
  const net = policy.network ?? {}
  return {
    network: {
      allowedDomains: net.allow ?? [],
      deniedDomains: net.deny ?? [],
      ...(gate &&
        needsInspection(policy) && {
          tlsTerminate: {
            ...(net.noInspect?.length && { excludeDomains: net.noInspect }),
            // A fixed CA (vm backend) so long-lived processes keep trusting the proxy from step to step.
            ...(opts.ca && { caCertPath: opts.ca.certPath, caKeyPath: opts.ca.keyPath }),
          },
          filterRequest: gate.filterRequest,
          // `/a/../b` or `%2e` spellings could name another resource than the one a rule judged.
          ambiguousRequestTarget: 'refuse' as const,
        }),
    },
    filesystem: {
      denyRead: fs.read?.deny ?? [],
      allowRead: fs.read?.allow ?? [],
      allowWrite: fs.write?.allow ?? [],
      // The sandbox must never rewrite its own history or snapshots.
      denyWrite: [...(fs.write?.deny ?? []), '.envgit'],
    },
  }
}

/**
 * Policy → Claude Code's own `sandbox` settings (for `envgit claude`), which wrap its Bash in srt too.
 * Paths are made absolute against the workdir; hosts lose their `:port` (Claude's allowlist is by
 * domain). Its sandbox has no request-level rules, so `network.l7` and irreversible net rules are not
 * enforced there — envgit's pre hook only judges command lines (docs/design.md §3.4).
 */
export function compileClaudeSandbox(policy: Policy, workdir: string): Record<string, unknown> {
  const fs = policy.filesystem ?? {}
  const net = policy.network ?? {}
  const abs = (p: string) => (p === '.' ? workdir : p.startsWith('/') || p.startsWith('~') || p.includes('*') ? p : join(workdir, p))
  const host = (h: string) => h.replace(/:\d+$/, '')
  return {
    enabled: true,
    filesystem: {
      allowRead: (fs.read?.allow ?? []).map(abs),
      denyRead: (fs.read?.deny ?? []).map(abs),
      allowWrite: (fs.write?.allow ?? []).map(abs),
      denyWrite: [...(fs.write?.deny ?? []).map(abs), join(workdir, '.envgit')],
    },
    network: { allowedDomains: (net.allow ?? []).map(host), deniedDomains: (net.deny ?? []).map(host) },
  }
}
