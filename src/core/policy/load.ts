import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { McpServerConfig } from '../mcp/client.js'
import { PRESETS } from './presets.js'
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
  }
  if (policy.irreversible) {
    // Expanded here, in place, so every consumer sees one flat list in match order.
    policy.irreversible = policy.irreversible.flatMap(rule => {
      if (!('preset' in rule)) return [rule]
      const rules = PRESETS[rule.preset]
      if (!rules) throw new Error(`${path}: irreversible preset ${JSON.stringify(rule.preset)} does not exist (there is: ${Object.keys(PRESETS).join(', ')})`)
      return rule.action ? rules.map(r => ({ ...r, action: rule.action })) : rules
    })
  }
  for (const rule of policy.irreversible ?? []) {
    if (!('net' in rule) && !('shell' in rule)) throw new Error(`${path}: irreversible rule needs net or shell: ${JSON.stringify(rule)}`)
  }
  for (const [name, server] of Object.entries(policy.mcp ?? {})) {
    // Each server is a global in the REPL, next to its own.
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || /^\$\d+$/.test(name) || REPL_GLOBALS.includes(name))
      throw new Error(`${path}: mcp server name ${JSON.stringify(name)} must be a JavaScript identifier other than $1, $2, … and ${REPL_GLOBALS.join(', ')}`)
    if (typeof server?.command !== 'string') throw new Error(`${path}: mcp.${name} needs a command`)
  }
  for (const name of Object.keys(policy.capabilities ?? {})) {
    if (BUILT_IN.includes(name) || policy.mcp?.[name]) continue
    throw new Error(
      name === 'github'
        ? `${path}: capabilities.github: the built-in GitHub functions are gone; connect GitHub's MCP server under mcp.github instead (docs/design.md §3.3)`
        : `${path}: capabilities.${name}: no such capability (built in: ${BUILT_IN.join(', ')}; or an mcp server of that name)`,
    )
  }
  return policy
}

/** The REPL's own capabilities; every other name is an MCP server. */
const BUILT_IN = ['fs', 'http', 'shell']
/** What the REPL already defines; an MCP server cannot take these names. */
export const REPL_GLOBALS = ['print', 'console', 'setTimeout', 'clearTimeout', 'URL', 'TextEncoder', 'TextDecoder', 'sample', 'schema', 'assert', 'AssertionError', 'fs', 'fetch', 'Headers', 'Request', 'Response']

/**
 * The MCP servers the REPL starts, with `${VAR}` in their env taken from envgit's environment here:
 * on the vm backend the worker's environment is the guest's, not this one. A server turned off by
 * `capabilities.<name>: false` is left out.
 */
export function mcpServers(policy: Policy, env: NodeJS.ProcessEnv = process.env): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [name, s] of Object.entries(policy.mcp ?? {})) {
    if (policy.capabilities?.[name] === false) continue
    const vars = Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v).replace(/\$\{(\w+)\}/g, (_, n: string) => env[n] ?? '')])
    out[name] = { command: s.command, ...(s.args && { args: s.args.map(String) }), ...(vars.length && { env: Object.fromEntries(vars) }) }
  }
  return out
}
