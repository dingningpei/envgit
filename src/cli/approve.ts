/** Asking a person at the terminal whether an irreversible action may go ahead (docs/design.md §4). */
import { closeSync, openSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import tty from 'node:tty'
import type { Approver } from '../core/policy/gate.js'

/**
 * Prompts on /dev/tty, not stdin: the sandboxed command inherits stdin and would race the prompt.
 * Undefined when envgit is not attached to a terminal. No answer within `timeoutMs` denies.
 */
export function ttyApprover(timeoutMs = 120_000): Approver | undefined {
  if (!process.stdin.isTTY && !process.stderr.isTTY) return undefined
  try {
    closeSync(openSync('/dev/tty', 'r+'))
  } catch {
    return undefined
  }
  return async ({ action, rule }) => {
    const fd = openSync('/dev/tty', 'r+')
    const input = new tty.ReadStream(fd)
    const output = new tty.WriteStream(fd)
    const rl = createInterface({ input, output })
    try {
      const answer = await rl.question(
        `\n\x1b[33menvgit: irreversible action\x1b[0m ${action}\n  rule: ${rule}\n  allow it? [y/N] (denied in ${timeoutMs / 1000}s) `,
        { signal: AbortSignal.timeout(timeoutMs) },
      )
      return /^y(es)?$/i.test(answer.trim())
    } catch {
      output.write('\n')
      return false
    } finally {
      rl.close()
      input.destroy()
    }
  }
}
