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
    l7?: Record<string, { methods?: string[]; paths?: string[] }>
  }
  capabilities?: Record<string, boolean | string[]>
  irreversible?: IrreversibleRule[]
  /** Workdir paths (prefixes) left out of snapshots. `.envgit` is always left out. */
  snapshot?: { exclude?: string[] }
}

export type IrreversibleRule =
  | { net: { host: string; method?: string; path?: string } }
  | { shell: string[] }
