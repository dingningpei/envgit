import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { Policy } from './schema.js'

export async function loadPolicy(path: string): Promise<Policy> {
  const doc = parse(await readFile(path, 'utf8'))
  if (doc != null && (typeof doc !== 'object' || Array.isArray(doc))) {
    throw new Error(`${path}: policy must be a mapping`)
  }
  const policy = (doc ?? {}) as Policy
  for (const rule of policy.irreversible ?? []) {
    // A typo here must not quietly turn a gate into something else.
    if (rule.action !== undefined && !['ask', 'deny', 'allow'].includes(rule.action)) {
      throw new Error(`${path}: irreversible rule action must be ask, deny or allow, got ${JSON.stringify(rule.action)}`)
    }
    if (!('net' in rule) && !('shell' in rule)) throw new Error(`${path}: irreversible rule needs net or shell: ${JSON.stringify(rule)}`)
  }
  return policy
}
