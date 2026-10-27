/** Policy → srt settings. See docs/design.md §3.2 */
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { needsInspection, type Gate } from './gate.js'
import type { Policy } from './schema.js'

/**
 * With request-level rules (`network.l7`, `irreversible` net rules) and a gate to apply them, srt
 * terminates TLS with a per-run CA (trusted in the sandbox through the usual *_CA_BUNDLE variables)
 * and hands every request to the gate. Without such rules HTTPS stays an opaque, host-allowlisted tunnel.
 */
/**
 * What one run needs beyond the policy — e.g. `envgit claude`, whose own process lives in the sandbox:
 * its config dir writable, its API hosts allowed but not decrypted.
 */
export interface SrtExtra {
  allowWrite?: string[]
  denyRead?: string[]
  allowedDomains?: string[]
  /** Hosts allowed through without TLS termination, whatever the policy's request rules. */
  noInspect?: string[]
  allowPty?: boolean
}

export function compileSrt(policy: Policy, gate?: Gate, opts: { ca?: { certPath: string; keyPath: string }; extra?: SrtExtra } = {}): SandboxRuntimeConfig {
  const x = opts.extra ?? {}
  const fs = policy.filesystem ?? {}
  const net = { ...policy.network, allow: [...(policy.network?.allow ?? []), ...(x.allowedDomains ?? [])], noInspect: [...(policy.network?.noInspect ?? []), ...(x.noInspect ?? [])] }
  return {
    ...(x.allowPty && { allowPty: true }),
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
      denyRead: [...(fs.read?.deny ?? []), ...(x.denyRead ?? [])],
      allowRead: fs.read?.allow ?? [],
      allowWrite: [...(fs.write?.allow ?? []), ...(x.allowWrite ?? [])],
      // The sandbox must never rewrite its own history or snapshots.
      denyWrite: [...(fs.write?.deny ?? []), '.envgit'],
    },
  }
}
