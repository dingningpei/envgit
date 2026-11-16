/** Policy → srt settings. See docs/design.md §3.2 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { needsInspection, tunnelDenials, type Gate } from './gate.js'
import type { Policy } from './schema.js'

/**
 * With request-level rules (`network.l7`, `irreversible` net rules) and a gate to apply them, srt
 * terminates TLS with a per-run CA (trusted in the sandbox through the usual *_CA_BUNDLE variables)
 * and hands every request to the gate. Without such rules HTTPS stays an opaque, host-allowlisted tunnel.
 */
/** Where envgit keeps what it must read and a sandbox must not (the token file `envgit claude` reads). */
export const ENVGIT_CONFIG_DIR = join(homedir(), '.config', 'envgit')

/**
 * Each absolute path also under the name the kernel sees. srt follows a symlink only in the cases it
 * knows (`/tmp/x`, `/var/x` on macOS) and drops the rest, bare `/tmp` among them: `write.allow: ["/tmp"]`
 * allowed nothing there, and a deny on a path below a symlinked directory (a dotfiles manager's
 * `~/.config`) would deny nothing.
 */
export function withRealPaths(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (!out.includes(p)) out.push(p)
    const abs = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    if (!isAbsolute(abs) || /[*?[\]{}]/.test(abs)) continue
    try {
      const real = realpathSync(abs)
      if (real !== abs && !out.includes(real)) out.push(real)
    } catch {
      // Not there (yet): the name as written is all there is.
    }
  }
  return out
}

/**
 * What one run needs beyond the policy — e.g. `envgit claude`, whose own process lives in the sandbox:
 * its config dir writable, its API hosts allowed.
 */
export interface SrtExtra {
  allowWrite?: string[]
  denyRead?: string[]
  denyWrite?: string[]
  allowedDomains?: string[]
  allowPty?: boolean
}

export function compileSrt(policy: Policy, gate?: Gate, opts: { ca?: { certPath: string; keyPath: string }; extra?: SrtExtra } = {}): SandboxRuntimeConfig {
  const x = opts.extra ?? {}
  const fs = policy.filesystem ?? {}
  const net = { ...policy.network, allow: [...(policy.network?.allow ?? []), ...(x.allowedDomains ?? [])] }
  const tunnels = tunnelDenials(policy)
  const sockets = net.allowUnixSockets ?? []
  return {
    ...(x.allowPty && { allowPty: true }),
    network: {
      allowedDomains: net.allow ?? [],
      // Denied before anything is allowed, so `tunnel` rules hold whatever network.allow says.
      deniedDomains: [...(net.deny ?? []), ...tunnels.domains],
      ...(tunnels.domains.length && { deniedDomainReasons: tunnels.reasons }),
      // The loader has refused sockets a `socket` rule guards (load.ts).
      ...(sockets.length && (process.platform === 'linux' ? { allowAllUnixSockets: true } : { allowUnixSockets: sockets })),
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
          // A CONNECT carrying plain HTTP (curl -p, Node's fetch for http://) or no TLS at all would pass
          // as an opaque tunnel the gate never sees; and a Host header could name another host than the
          // one connected to. Both are refused while request rules apply (docs/design.md §4).
          refuseOpaqueTunnels: true,
          requireHostMatch: true,
        }),
    },
    filesystem: {
      // envgit's own files outside the workdir (the token `envgit claude` reads): never readable inside.
      denyRead: withRealPaths([...(fs.read?.deny ?? []), ...(x.denyRead ?? []), ENVGIT_CONFIG_DIR]),
      allowRead: fs.read?.allow ?? [],
      allowWrite: withRealPaths([...(fs.write?.allow ?? []), ...(x.allowWrite ?? [])]),
      // The sandbox must never rewrite its own history or snapshots.
      denyWrite: withRealPaths([...(fs.write?.deny ?? []), ...(x.denyWrite ?? []), '.envgit']),
    },
  }
}
