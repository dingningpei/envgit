/** Policy → srt settings. See docs/design.md §3.2 */
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { Policy } from './schema.js'

// l7, capabilities and irreversible.net are not enforced on srt.
export function compileSrt(policy: Policy): SandboxRuntimeConfig {
  const fs = policy.filesystem ?? {}
  const net = policy.network ?? {}
  return {
    network: {
      allowedDomains: net.allow ?? [],
      deniedDomains: net.deny ?? [],
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

export function matchIrreversible(policy: Policy, argv: string[]): string | undefined {
  const cmd = argv.join(' ')
  for (const rule of policy.irreversible ?? []) {
    if (!('shell' in rule)) continue
    const hit = rule.shell.find(p => cmd === p || cmd.startsWith(p + ' '))
    if (hit) return `shell: ${hit}`
  }
  return undefined
}
