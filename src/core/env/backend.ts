/** Environment backend contract. See docs/design.md §3.1 */
import type { Policy } from '../policy/schema.js'

export type SnapshotId = string & { readonly __brand: 'SnapshotId' }

export interface EnvSpec {
  workdir: string
  image?: string
  policy?: Policy
}

export interface Env {
  id: string
  backend: string
}

export interface Command {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  effects: Effect[]
}

export type Effect =
  | { kind: 'fs'; op: 'read' | 'write' | 'delete'; path: string; denied?: boolean }
  | { kind: 'net'; host: string; port: number; method?: string; path?: string; denied?: boolean }
  | { kind: 'proc'; argv: string[] }
  | { kind: 'policy'; denied: true; reason: string }

export interface EnvBackend {
  readonly name: string
  create(spec: EnvSpec): Promise<Env>
  snapshot(env: Env): Promise<SnapshotId>
  restore(id: SnapshotId): Promise<Env>
  exec(env: Env, cmd: Command, signal?: AbortSignal): Promise<ExecResult>
  destroy(env: Env): Promise<void>
}
