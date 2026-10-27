/**
 * Hook relay for agents that run inside envgit's sandbox (`envgit claude`). The hook process is the
 * agent's child, so it cannot write `.envgit`; it drops its event into a spool directory the sandbox
 * may write, and waits while the `envgit claude` process outside the sandbox handles it with
 * runHook — the same code as for an agent outside the sandbox — and writes back the reply.
 *
 *   <spool>/<id>.json   {agent, event, input}, written to a temp name and renamed into place
 *   <spool>/<id>.out    what the hook prints (a pre hook's decision), same way
 */
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from './normalize.js'
import type { HookEvent } from './handler.js'

export const SPOOL_ENV = 'ENVGIT_HOOK_SPOOL'

export interface SpoolRequest {
  agent: Agent
  event: HookEvent
  input: string
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, path)
}

/** The hook's side: hand the event over and wait for the answer; undefined on timeout. */
export async function relay(spool: string, req: SpoolRequest, timeoutMs: number): Promise<string | undefined> {
  const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeAtomic(join(spool, `${id}.json`), JSON.stringify(req))
  const out = join(spool, `${id}.out`)
  const t0 = Date.now()
  for (let wait = 10; Date.now() - t0 < timeoutMs; wait = Math.min(wait * 2, 100)) {
    const text = await readFile(out, 'utf8').catch(() => undefined)
    if (text !== undefined) {
      await rm(out, { force: true })
      return text
    }
    await new Promise(r => setTimeout(r, wait))
  }
  return undefined
}

/** The parent's side: handles requests one at a time, in arrival order, until stopped. */
export function serveSpool(spool: string, handle: (req: SpoolRequest) => Promise<string>, log: (line: string) => void) {
  let stopped = false
  let busy: Promise<void> = Promise.resolve()
  const tick = async () => {
    const names = (await readdir(spool).catch(() => [] as string[])).filter(n => n.endsWith('.json')).sort()
    for (const name of names) {
      const path = join(spool, name)
      const text = await readFile(path, 'utf8').catch(() => undefined)
      await rm(path, { force: true })
      if (text === undefined) continue
      let out = ''
      try {
        out = await handle(JSON.parse(text) as SpoolRequest)
      } catch (e) {
        log(`envgit: hook failed: ${e instanceof Error ? e.message : e}`)
      }
      await writeAtomic(join(spool, name.replace(/\.json$/, '.out')), out)
    }
  }
  const loop = async () => {
    while (!stopped) {
      busy = tick()
      await busy
      await new Promise(r => setTimeout(r, 25))
    }
  }
  void loop()
  return {
    /** Handles what is still queued, then stops. */
    async stop() {
      stopped = true
      await busy
      await tick()
    },
  }
}
