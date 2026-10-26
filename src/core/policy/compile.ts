/** Policy → srt settings. See docs/design.md §3.2 */
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { needsInspection, type Gate } from './gate.js'
import type { Policy } from './schema.js'

/**
 * With request-level rules (`network.l7`, `irreversible` net rules) and a gate to apply them, srt
 * terminates TLS with a per-run CA (trusted in the sandbox through the usual *_CA_BUNDLE variables)
 * and hands every request to the gate. Without such rules HTTPS stays an opaque, host-allowlisted tunnel.
 */
export function compileSrt(policy: Policy, gate?: Gate): SandboxRuntimeConfig {
  const fs = policy.filesystem ?? {}
  const net = policy.network ?? {}
  return {
    network: {
      allowedDomains: net.allow ?? [],
      deniedDomains: net.deny ?? [],
      ...(gate &&
        needsInspection(policy) && {
          tlsTerminate: { ...(net.noInspect?.length && { excludeDomains: net.noInspect }) },
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
