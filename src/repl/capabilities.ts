/** Capabilities injected into the REPL, driven by policy.capabilities. See docs/design.md §3.2–3.3 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Effect } from '../core/env/backend.js'
import type { Policy } from '../core/policy/schema.js'

export interface Capabilities {
  globals: Record<string, unknown>
  /** TypeScript-style declarations of the injected API, shown to the model. */
  declarations: string
}

type Caps = NonNullable<Policy['capabilities']>

const GITHUB = {
  listIssues: {
    decl: 'listIssues(args: { owner: string; repo: string; state?: "open" | "closed" | "all"; per_page?: number }): Promise<Issue[]>',
    fn: (gh: GitHubClient) => (a: { owner: string; repo: string; state?: string; per_page?: number }) =>
      gh(`/repos/${seg(a.owner)}/${seg(a.repo)}/issues`, { state: a.state ?? 'open', per_page: String(a.per_page ?? 30) }),
  },
  getIssue: {
    decl: 'getIssue(args: { owner: string; repo: string; number: number }): Promise<Issue>',
    fn: (gh: GitHubClient) => (a: { owner: string; repo: string; number: number }) =>
      gh(`/repos/${seg(a.owner)}/${seg(a.repo)}/issues/${Number(a.number)}`),
  },
} as const

type GitHubClient = (path: string, query?: Record<string, string>) => Promise<unknown>

/**
 * Effects are observed here, at the syscall/proxy result the wrapper sees. This is
 * the reliable per-step channel; the macOS violation log drops events.
 */
export function buildCapabilities(caps: Caps, workdir: string, onEffect: (e: Effect) => void = () => {}): Capabilities {
  const globals: Record<string, unknown> = {}
  const decls = ['declare function print(...values: unknown[]): void']
  const tracedFetch = traceFetch(onEffect)

  if (caps.fs === true) {
    const fsOp = <T>(op: 'read' | 'write', path: string, f: (abs: string) => Promise<T>): Promise<T> => {
      const abs = resolve(workdir, path)
      return f(abs).then(
        r => (onEffect({ kind: 'fs', op, path: abs }), r),
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'EPERM' || e.code === 'EACCES') onEffect({ kind: 'fs', op, path: abs, denied: true })
          throw e
        },
      )
    }
    globals.fs = {
      readFile: (path: string) => fsOp('read', path, abs => readFile(abs, 'utf8')),
      writeFile: (path: string, data: string) => fsOp('write', path, abs => writeFile(abs, data)),
      readdir: (path = '.') => fsOp('read', path, async abs => (await readdir(abs, { withFileTypes: true })).map(d => (d.isDirectory() ? `${d.name}/` : d.name))),
    }
    decls.push(`declare const fs: {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  /** Directory names end with '/'. */
  readdir(path?: string): Promise<string[]>
}`)
  }

  if (caps.http === true) {
    globals.fetch = tracedFetch
    globals.Headers = Headers
    globals.Request = Request
    globals.Response = Response
    decls.push('declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>')
  }

  const gh = allowed(caps.github, Object.keys(GITHUB)) as (keyof typeof GITHUB)[]
  if (gh.length) {
    const client = githubClient(tracedFetch)
    globals.github = Object.fromEntries(gh.map(n => [n, GITHUB[n].fn(client)]))
    decls.push(`type Issue = { number: number; title: string; state: string; body: string | null; labels: { name: string }[]; user: { login: string }; html_url: string }
declare const github: {
${gh.map(n => `  ${GITHUB[n].decl}`).join('\n')}
}`)
  }

  return { globals, declarations: decls.join('\n') }
}

function allowed(cap: boolean | string[] | undefined, all: string[]): string[] {
  if (cap === true) return all
  if (Array.isArray(cap)) return cap.filter(n => all.includes(n))
  return []
}

function traceFetch(onEffect: (e: Effect) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const net = { kind: 'net' as const, host: url.hostname, port: Number(url.port) || (url.protocol === 'http:' ? 80 : 443), method, path: url.pathname }
    try {
      const res = await fetch(input, init)
      // A 403 from envgit's gate is already on the step as the gate's own effect; don't record it twice.
      const gated = res.status === 403 && (await res.clone().text().then(t => t.startsWith('envgit: '), () => false))
      if (!gated) onEffect(net)
      return res
    } catch (e) {
      if (proxyRefused(e)) onEffect({ ...net, denied: true })
      throw e
    }
  }
}

// srt's proxy refuses a CONNECT with 403; undici buries that a few causes deep.
function proxyRefused(e: unknown): boolean {
  for (let c = e, i = 0; c instanceof Error && i < 5; c = c.cause, i++) {
    if (/Proxy response \(403\)/.test(c.message)) return true
  }
  return false
}

function githubClient(fetch: typeof globalThis.fetch): GitHubClient {
  return async (path, query) => {
    const url = new URL(path, 'https://api.github.com')
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'envgit' } })
    if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}: ${url.pathname}`)
    return res.json()
  }
}

function seg(s: string): string {
  return encodeURIComponent(String(s))
}
