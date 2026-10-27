/** Policy file shape. See docs/design.md §3.2 */

export interface Policy {
  /** Environment backend: `srt` (default, OS sandbox) or `vm` (nested Firecracker, docs/design.md §3.6). */
  backend?: 'srt' | 'vm'
  filesystem?: {
    read?: { allow?: string[]; deny?: string[] }
    write?: { allow?: string[]; deny?: string[] }
  }
  network?: {
    allow?: string[]
    deny?: string[]
    /** Per host (glob, optional `:port`): only these methods / paths (`*` one segment, `**` any) go through. */
    l7?: Record<string, { methods?: string[]; paths?: string[] }>
    /** Hosts never TLS-terminated (certificate pinning, mTLS); request rules cannot see their HTTPS traffic. */
    noInspect?: string[]
  }
  capabilities?: Record<string, boolean | string[]>
  irreversible?: IrreversibleRule[]
  /**
   * `exclude`: workdir paths (prefixes) left out of snapshots (`.envgit` always is).
   * `maxBytes` (`500M`, `10G`, or bytes): drop the oldest rewind points to keep snapshots under it.
   */
  snapshot?: { exclude?: string[]; maxBytes?: number | string }
}

/** `ask` (default) a person, `deny`, or `allow` and just mark the step. */
export type IrreversibleAction = 'ask' | 'deny' | 'allow'

export type IrreversibleRule =
  | { net: { host: string; method?: string; path?: string }; action?: IrreversibleAction }
  | { shell: string[]; action?: IrreversibleAction }
