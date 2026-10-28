/**
 * `envgit codex-http-helper`: makes one of Codex's `http/request`s from inside envgit's sandbox, so it
 * goes through the proxy and the gate like any command (docs/design.md §3.4). proxiedFetch sends
 * `http://` as an ordinary proxied request and `https://` through fetch's CONNECT, which the proxy
 * terminates; fetch follows HTTP(S)_PROXY (NODE_USE_ENV_PROXY) and trusts srt's CA (NODE_EXTRA_CA_CERTS).
 *
 *   stdin   the request: {method, url, headers: [{name, value, valueEnvVar?}], bodyBase64?, timeoutMs?, redirectPolicy?}
 *   stdout  one JSON line {status, headers: [{name, value}]}, then the response body, raw
 *   exit 1  with the reason on stderr, when there is no response at all
 */
import { proxiedFetch } from '../../core/env/proxied-fetch.js'

export async function httpHelper(): Promise<number> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const req = JSON.parse(text) as {
    method: string
    url: string
    headers?: { name: string; value: string; valueEnvVar?: string }[]
    bodyBase64?: string
    timeoutMs?: number | null
    redirectPolicy?: 'follow' | 'stop'
  }
  const headers = new Headers()
  // A header can name an environment variable of the executor (a token): its value follows the prefix.
  for (const h of req.headers ?? []) headers.append(h.name, h.valueEnvVar ? h.value + (process.env[h.valueEnvVar] ?? '') : h.value)
  let res: Response
  try {
    res = await proxiedFetch(req.url, {
      method: req.method,
      headers,
      ...(req.bodyBase64 && { body: new Uint8Array(Buffer.from(req.bodyBase64, 'base64')) }),
      redirect: req.redirectPolicy === 'stop' ? 'manual' : 'follow',
      ...(req.timeoutMs != null && { signal: AbortSignal.timeout(req.timeoutMs) }),
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : ''
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}${cause}\n`)
    return 1
  }
  const out: { name: string; value: string }[] = []
  res.headers.forEach((value, name) => out.push({ name, value }))
  process.stdout.write(JSON.stringify({ status: res.status, headers: out }) + '\n')
  if (res.body) for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) process.stdout.write(chunk)
  return 0
}
