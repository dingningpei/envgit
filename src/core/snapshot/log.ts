/** Append-only action log. See docs/design.md §2 */
import type { Effect, SnapshotId } from '../env/backend.js'

export interface Step {
  index: number
  startedAt: string
  endedAt: string
  action: { type: 'exec' | 'repl'; input: string }
  exitCode: number
  effects: Effect[]
  irreversible?: { reason: string }
  snapshot?: SnapshotId
  parent?: number
}

export interface Session {
  id: string
  createdAt: string
  steps: Step[]
}
