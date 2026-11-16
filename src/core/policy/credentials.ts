/**
 * Credentials the sandbox may use and not read (docs/design.md §4, "Credentials").
 *
 * envgit does not build this: sandbox-runtime masks a declared environment variable (the sandbox sees a
 * stand-in, `fake_value_…`) and its proxy puts the real value back, in headers and bodies, on requests
 * to the hosts that credential names — over TLS it terminates, nowhere else. What envgit adds is where
 * the value comes from (a file it reads outside, or its own environment), the policy syntax, and
 * turning TLS termination on for it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Policy } from './schema.js'

export interface Credential {
  /** The variable's name, inside the sandbox and in envgit's own environment. */
  name: string
  /** The real value is put back on requests to these hosts and no others. */
  hosts: string[]
  /** The file its value was read from: read-denied inside. */
  file?: string
}

/**
 * Makes each credential's real value available to sandbox-runtime, which reads it from this process's
 * environment, and returns the ones that have a value. A file wins over the environment: on macOS a
 * sandboxed process can read the environment envgit was *started* with (sysctl kern.procargs2 of a
 * process of the same user), so a secret exported before envgit runs is readable inside whatever is
 * masked. A value read from a file and set here afterwards is not in that record.
 */
export async function resolveCredentials(policy: Policy, extra: Credential[] = [], log: (line: string) => void = () => {}): Promise<Credential[]> {
  const out: Credential[] = []
  const declared = Object.entries(policy.credentials ?? {}).map(([name, c]) => ({ name, hosts: c.hosts, file: c.file }))
  for (const c of [...declared, ...extra.map(e => ({ ...e, file: undefined as string | undefined }))]) {
    if (out.some(o => o.name === c.name)) continue
    let from = 'envgit\'s environment'
    let path: string | undefined
    if (c.file) {
      path = resolve(c.file.replace(/^~(?=\/|$)/, homedir()))
      const value = (await readFile(path, 'utf8').catch(e => {
        throw new Error(`credentials.${c.name}: cannot read ${path} (${e.code ?? e})`)
      })).trim()
      if (!value) throw new Error(`credentials.${c.name}: ${path} is empty`)
      process.env[c.name] = value
      from = c.file
    } else if (STARTED_WITH.has(c.name) && process.platform === 'darwin') {
      log(`envgit: ${c.name} was in the environment envgit started with, which a sandboxed process on macOS can read; keep it in a file instead (credentials.${c.name}.file, or ~/.config/envgit/ for \`envgit claude\`)`)
    }
    if (!process.env[c.name]) {
      log(`envgit: credentials.${c.name} has no value (not in ${from}), so the sandbox gets none`)
      continue
    }
    out.push({ name: c.name, hosts: c.hosts, ...(path && { file: path }) })
    log(`envgit: ${c.name} stays outside the sandbox; sent only to ${c.hosts.join(', ')}`)
  }
  return out
}

/** The names envgit's own process was started with: those are in the kernel's record of it (see above). */
const STARTED_WITH = new Set(Object.keys(process.env))
