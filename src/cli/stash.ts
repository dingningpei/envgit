/**
 * Credentials out of envgit's own start-up record (docs/design.md §4.1).
 *
 * On macOS a process can read another process's start-up environment (`sysctl kern.procargs2`) when
 * both run as the same user, sandboxed or not; masking only changes what the sandboxed process is
 * *given*. So a credential exported in the shell that runs envgit would be readable from inside the
 * sandbox, in envgit's record. Before it starts a sandbox, envgit moves such variables into a file only
 * it can read and replaces itself (execve, same pid, same terminal) with an image started without
 * them; the new image reads them back from the file and deletes it. The kernel's record of the new
 * image holds the file's path, not the values.
 *
 * What it cannot reach: the shell (or any other process) that was itself started with the secret in
 * its environment. A variable exported later in an interactive shell is not in that shell's record.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STASH_ENV = 'ENVGIT_CREDENTIAL_STASH'

/** Set once this image has restored a stash: it is the restarted one, and must not restart again. */
let restarted = false

/** In the image envgit replaced itself with: put the moved variables back, and remove the file. */
export function restoreStash(): void {
  const file = process.env[STASH_ENV]
  if (!file) return
  delete process.env[STASH_ENV]
  restarted = true
  try {
    Object.assign(process.env, JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
}

/**
 * Moves `names` that are set out of the environment envgit was started with, by replacing the process
 * (macOS only: on Linux the sandbox has its own pid namespace and cannot see envgit). Returns only when
 * there is nothing to move, or no way to (Node without process.execve).
 */
export function restartWithout(names: string[], log: (line: string) => void): void {
  // (An empty ENVGIT_CREDENTIAL_STASH turns the restart off: the tests' control.)
  if (process.platform !== 'darwin' || restarted || process.env[STASH_ENV] !== undefined) return
  const moved = names.filter(n => process.env[n])
  if (!moved.length) return
  const execve = (process as unknown as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve
  if (typeof execve !== 'function') {
    log(`envgit: ${moved.join(', ')} came in through the environment, which a sandboxed process can read on macOS, and this Node cannot restart envgit without it (needs process.execve, Node 22.15+); keep it in a file instead`)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'envgit-stash-'))
  const file = join(dir, 'env.json')
  writeFileSync(file, JSON.stringify(Object.fromEntries(moved.map(n => [n, process.env[n]!]))), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { ...process.env, [STASH_ENV]: file }
  for (const n of moved) delete env[n]
  try {
    execve.call(process, process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], env)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    log(`envgit: could not restart without ${moved.join(', ')} in the environment (${e instanceof Error ? e.message : e}); a sandboxed process on macOS can read it there`)
  }
}
