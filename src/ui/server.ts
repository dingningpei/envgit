/**
 * `envgit ui`: the session timeline in a browser (docs/design.md §3.7). A loopback HTTP server with a
 * random token in its URL — the page can rewind and fork, so every API call must carry the token
 * (POSTs in a header, so a plain link cannot mutate) and name this host (no DNS rebinding).
 * Rewind and fork run the CLI itself, so the busy lock and drift checks are the same as at a terminal.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import type { SnapshotId } from '../core/env/backend.js'
import { activeChain, busyHolder, readHead, type SessionMeta, type Step } from '../core/snapshot/log.js'
import type { Entry } from '../core/snapshot/store.js'
import { SnapshotStore } from '../core/snapshot/store.js'
import { unifiedDiff, type Hunk } from './diff.js'
import { PAGE } from './page.js'

export interface UiOptions {
  workdir: string
  /** The workdir's .envgit. */
  root: string
  /** This CLI's entry point, run for rewind and fork. */
  cli: string
  port?: number
}

const MAX_DIFF_FILES = 200
const MAX_DIFF_BYTES = 1 << 20

export async function serveUi(o: UiOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(18).toString('base64url')
  const server = http.createServer((req, res) => {
    handle(o, token, port, req, res).catch(e => send(res, 500, { error: e instanceof Error ? e.message : String(e) }))
  })
  await new Promise<void>(r => server.listen(o.port ?? 0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    close: () => new Promise<void>(r => (server.closeAllConnections(), server.close(() => r()))),
  }
}

function send(res: http.ServerResponse, code: number, body: unknown, type = 'application/json'): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

async function handle(o: UiOptions, token: string, port: number, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403, { error: 'wrong host' })
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (req.method === 'GET' && url.pathname === `/${token}/`) return send(res, 200, PAGE, 'text/html; charset=utf-8')
  const api = `/${token}/api/`
  if (!url.pathname.startsWith(api)) return send(res, 404, { error: 'not found' })
  const route = url.pathname.slice(api.length)
  if (req.method === 'GET' && route === 'state') return send(res, 200, await state(o, url.searchParams.get('session') ?? undefined))
  if (req.method === 'GET' && route === 'diff') return send(res, 200, await diff(o, url.searchParams.get('session') ?? '', Number(url.searchParams.get('step'))))
  if (req.method === 'POST' && (route === 'rewind' || route === 'fork')) {
    if (req.headers['x-envgit-token'] !== token) return send(res, 403, { error: 'missing token header' })
    const body = JSON.parse((await readBody(req)) || '{}') as { step?: number | 'base'; force?: boolean; dir?: string }
    const step = body.step === 'base' ? 'base' : Number.isInteger(body.step) ? String(body.step) : undefined
    if (!step) return send(res, 400, { error: 'step must be a step number or "base"' })
    if (route === 'rewind') return send(res, 200, await cli(o, ['rewind', step, ...(body.force ? ['--force'] : [])]))
    if (!body.dir) return send(res, 400, { error: 'dir is required' })
    const dir = isAbsolute(body.dir) ? body.dir : resolve(o.workdir, '..', body.dir)
    return send(res, 200, { ...(await cli(o, ['fork', step, dir])), dir })
  }
  send(res, 404, { error: 'not found' })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', d => {
      body += d
      if (body.length > 1 << 16) req.destroy(new Error('body too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function cli(o: UiOptions, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [o.cli, ...args], { cwd: o.workdir, timeout: 600_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

/** Like readSteps, but a step still being appended (a partial last line) is left for the next poll. */
async function readStepsLive(dir: string): Promise<Step[]> {
  const text = await readFile(join(dir, 'steps.jsonl'), 'utf8').catch(() => '')
  const steps: Step[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      steps.push(JSON.parse(line) as Step)
    } catch {
      break
    }
  }
  return steps
}

async function readMeta(o: UiOptions, id: string): Promise<SessionMeta | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined
  return readFile(join(o.root, 'sessions', id, 'session.json'), 'utf8').then(t => JSON.parse(t) as SessionMeta, () => undefined)
}

async function state(o: UiOptions, selected?: string) {
  const current = await readFile(join(o.root, 'current'), 'utf8').then(s => s.trim(), () => '')
  const ids = (await readdir(join(o.root, 'sessions')).catch(() => [] as string[])).sort()
  const sessions = []
  for (const id of ids) {
    const meta = await readMeta(o, id)
    if (!meta) continue
    sessions.push({ id, createdAt: meta.createdAt, backend: meta.backend, forkedFrom: meta.forkedFrom, steps: (await readStepsLive(join(o.root, 'sessions', id))).length })
  }
  const id = selected && sessions.some(s => s.id === selected) ? selected : current || sessions.at(-1)?.id
  const policy = await readFile(join(o.root, 'policy.yaml'), 'utf8').catch(() => '')
  const busy = await busyHolder(o.root)
  if (!id) return { workdir: o.workdir, current, sessions, policyBackend: /^backend:\s*vm\b/m.test(policy) ? 'vm' : 'srt', busy }
  const dir = join(o.root, 'sessions', id)
  const meta = (await readMeta(o, id))!
  const steps = await readStepsLive(dir)
  const head = await readHead(dir)
  return {
    workdir: o.workdir,
    current,
    sessions,
    policyBackend: /^backend:\s*vm\b/m.test(policy) ? 'vm' : 'srt',
    busy,
    session: { meta, head, steps, chain: activeChain(steps, head).map(s => s.index) },
  }
}

type FileChange = { path: string; status: 'added' | 'deleted' | 'modified'; kind: string; hunks?: Hunk[]; note?: string }

/** What a step changed in the workdir: its snapshot against its parent's (fs-level snapshots, srt only). */
async function diff(o: UiOptions, sessionId: string, index: number) {
  const meta = await readMeta(o, sessionId)
  if (!meta) return { error: 'no such session' }
  if (meta.backend === 'vm') return { unavailable: 'vm snapshots are memory and disk images; the step’s file effects (from the mirror sync) list what changed in /work' }
  const steps = await readStepsLive(join(o.root, 'sessions', sessionId))
  const step = steps[index]
  if (!step?.snapshot) return { error: 'no such step, or it has no snapshot' }
  const parentId = step.parent === undefined ? meta.base : steps[step.parent]?.snapshot
  const store = new SnapshotStore(o.root)
  const read = async (id: SnapshotId | undefined) => (id && (await store.has(id)) ? new Map((await store.read(id)).entries.map(e => [e.path, e])) : undefined)
  const [before, after] = [await read(parentId), await read(step.snapshot)]
  if (!after) return { error: 'the step’s snapshot is gone (envgit gc?)' }
  const prev = before ?? new Map<string, Entry>()
  const changes: FileChange[] = []
  const same = (a: Entry, b: Entry) =>
    a.kind === b.kind && (a.kind === 'file' ? a.hash === (b as typeof a).hash && a.mode === (b as typeof a).mode : a.kind === 'symlink' ? a.target === (b as typeof a).target : true)
  for (const [path, e] of after) {
    const p = prev.get(path)
    if (!p) changes.push({ path, status: 'added', kind: e.kind })
    else if (!same(p, e)) changes.push({ path, status: 'modified', kind: e.kind })
  }
  for (const [path, e] of prev) if (!after.has(path)) changes.push({ path, status: 'deleted', kind: e.kind })
  changes.sort((a, b) => a.path.localeCompare(b.path))
  const shown = changes.filter(c => c.kind !== 'dir').slice(0, MAX_DIFF_FILES)
  for (const c of shown) {
    const a = prev.get(c.path)
    const b = after.get(c.path)
    if ((a && a.kind !== 'file') || (b && b.kind !== 'file')) {
      c.note = [a, b].map(e => (e?.kind === 'symlink' ? `symlink → ${e.target}` : e?.kind)).filter(Boolean).join(' → ')
      continue
    }
    const sizes = [a, b].map(e => (e?.kind === 'file' ? e.size : 0))
    if (Math.max(...sizes) > MAX_DIFF_BYTES) {
      c.note = `too large to show (${sizes.map(n => `${(n / 1e6).toFixed(1)} MB`).join(' → ')})`
      continue
    }
    const text = async (e?: Entry) => (e?.kind === 'file' ? await store.readBlob(e.hash).catch(() => undefined) : Buffer.alloc(0))
    const [ta, tb] = [await text(a), await text(b)]
    if (!ta || !tb) c.note = 'contents no longer stored'
    else if (ta.subarray(0, 8192).includes(0) || tb.subarray(0, 8192).includes(0)) c.note = 'binary'
    else {
      const hunks = unifiedDiff(ta.toString('utf8'), tb.toString('utf8'))
      if (hunks) c.hunks = hunks
      else c.note = 'too many lines to diff'
    }
    if (c.status === 'modified' && a?.kind === 'file' && b?.kind === 'file' && a.hash === b.hash) c.note = `mode ${a.mode.toString(8)} → ${b.mode.toString(8)}`
  }
  return { files: shown, more: changes.filter(c => c.kind !== 'dir').length - shown.length, dirs: changes.filter(c => c.kind === 'dir').map(c => `${c.status} ${c.path}/`), baseMissing: !before }
}
