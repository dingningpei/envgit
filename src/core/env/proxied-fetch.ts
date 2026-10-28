/**
 * `fetch` for code inside envgit's sandbox. Node's fetch sends even `http://` through the proxy as a
 * CONNECT tunnel, which the gate cannot see into and refuses while request rules apply (docs/design.md
 * §4). So plain HTTP goes as an ordinary proxied request (absolute-form, to HTTP_PROXY) and comes back
 * as a standard Response; HTTPS, and anything without a proxy, is fetch's own.
 */
import http from 'node:http'
import { Readable } from 'node:stream'

const MAX_REDIRECTS = 5

export async function proxiedFetch(input: string | URL | Request, init?: RequestInit, hops = 0): Promise<Response> {
  const req = new Request(input, init)
  const url = new URL(req.url)
  const proxyUrl = process.env.HTTP_PROXY ?? process.env.http_proxy
  if (url.protocol !== 'http:' || !proxyUrl) return fetch(req)
  const proxy = new URL(proxyUrl)
  const headers: string[] = []
  req.headers.forEach((value, name) => {
    if (name !== 'host') headers.push(name, value)
  })
  headers.push('host', url.host)
  if (proxy.username) headers.push('proxy-authorization', `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`)
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const r = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        method: req.method,
        path: url.href,
        headers,
        // Its own agent: the global one follows NODE_USE_ENV_PROXY and would proxy this to the proxy again.
        agent: new http.Agent(),
        signal: req.signal,
      },
      resolve,
    )
    r.on('error', reject)
    r.end(body)
  })
  const out = new Headers()
  for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
  const status = res.statusCode ?? 502
  // A null-body status must not carry a body stream.
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304 || req.method === 'HEAD'
  if (nullBody) res.resume()
  const response = new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: out })
  // Redirects: follow them like fetch would, unless asked not to.
  const location = out.get('location')
  if (location && status >= 300 && status < 400 && req.redirect === 'follow' && hops < MAX_REDIRECTS) {
    res.resume()
    const next = new URL(location, url)
    const keepBody = !(status === 303 || ((status === 301 || status === 302) && req.method === 'POST'))
    return proxiedFetch(next, { method: keepBody ? req.method : 'GET', headers: req.headers, ...(keepBody && body && { body: new Uint8Array(body) }), redirect: 'follow', signal: req.signal }, hops + 1)
  }
  return response
}
