/** Policy file shape. See docs/design.md §3.2 */
import type { McpServerConfig } from '../mcp/client.js'

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
  /**
   * What the REPL exposes: `fs`, `http`, and each MCP server below by name (on unless `false`; a list
   * keeps only those tools).
   */
  capabilities?: Record<string, boolean | string[]>
  /**
   * MCP servers whose tools become REPL functions (`await <name>.<tool>(args)`). They run inside the
   * sandbox, started by the REPL worker; `${VAR}` in `env` comes from envgit's environment.
   */
  mcp?: Record<string, McpServerConfig>
  /** Gated actions, first match wins; `- preset: default` adds envgit's stock rules at that point. */
  irreversible?: IrreversibleRule[]
  /**
   * `exclude`: workdir paths (prefixes) left out of snapshots (`.envgit` always is).
   * `maxBytes` (`500M`, `10G`, or bytes): drop the oldest rewind points to keep snapshots under it.
   */
  snapshot?: { exclude?: string[]; maxBytes?: number | string }
}

/** `ask` (default) a person, `deny`, or `allow` and just mark the step. */
export type IrreversibleAction = 'ask' | 'deny' | 'allow'

/**
 * `name` labels the rule in messages and the step log. `{ preset }` is expanded by the loader, its
 * `action` (if set) replacing the stock rules' `ask`.
 */
export type IrreversibleRule =
  | { net: NetRule; action?: IrreversibleAction; name?: string }
  | { shell: string[]; action?: IrreversibleAction; name?: string }
  | { preset: string; action?: IrreversibleAction }

/** One host (glob, optional `:port`); any of `method`; any of `path` (`*` one segment, `**` any). */
export interface NetRule {
  host: string
  method?: string | string[]
  path?: string | string[]
}

/** What the gate sees once presets are expanded. */
export type ConcreteRule = Exclude<IrreversibleRule, { preset: string }>
