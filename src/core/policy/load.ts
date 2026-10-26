import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { Policy } from './schema.js'

export async function loadPolicy(path: string): Promise<Policy> {
  const doc = parse(await readFile(path, 'utf8'))
  if (doc != null && (typeof doc !== 'object' || Array.isArray(doc))) {
    throw new Error(`${path}: policy must be a mapping`)
  }
  return (doc ?? {}) as Policy
}
