/** Sandboxed REPL worker: newline-delimited JSON over stdin/stdout. Runs under srt. */
import { createInterface } from 'node:readline'
import type { Effect } from '../core/env/backend.js'
import type { Policy } from '../core/policy/schema.js'
import { buildCapabilities } from './capabilities.js'
import { VmEngine } from './engine.js'

export interface WorkerRequest {
  id: number
  code: string
}

export type WorkerMessage = { ready: true } | { id: number; output: string; error?: string; effects: Effect[] }

export const CAPABILITIES_ENV = 'ENVGIT_CAPABILITIES'

export async function runWorker(): Promise<void> {
  const caps = JSON.parse(process.env[CAPABILITIES_ENV] ?? '{}') as NonNullable<Policy['capabilities']>
  let effects: Effect[] = []
  const engine = new VmEngine(buildCapabilities(caps, process.cwd(), e => effects.push(e)).globals)
  const send = (m: WorkerMessage) => process.stdout.write(JSON.stringify(m) + '\n')
  send({ ready: true })
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    const req = JSON.parse(line) as WorkerRequest
    effects = []
    const result = await engine.execute(req.code)
    send({ id: req.id, ...result, effects })
  }
}
