/**
 * Egress for the vm backend (docs/design.md §3.6): while a step runs, envgit starts srt's proxy with
 * the policy's allowlist and the irreversible-action gate, and serves the unix socket envgit-vm
 * hands L2's proxy connections to. Between steps nothing listens, so L2 has no way out.
 */
import { rm } from 'node:fs/promises'
import net from 'node:net'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { compileSrt } from '../policy/compile.js'
import type { Gate } from '../policy/gate.js'
import type { Policy } from '../policy/schema.js'
import type { Effect } from './backend.js'
import { notGated, toEffect } from './srt.js'
import { vmProxySocket } from './vm.js'

/** L2's side of the tunnel and its CA bundle (written by the agent's `trust` op). */
const L2_PROXY = '127.0.0.1:3128'
const L2_CA = '/etc/envgit/ca.pem'

export interface Egress {
  /** Environment for commands in L2: proxy URL (with this run's token) and CA bundle. */
  env: Record<string, string>
  /** PEM of the per-run CA when TLS is terminated (to append to L2's roots), else empty. */
  ca: string
  /** Host allowlist denials since `since`, as step effects. */
  denials(since: Date): Effect[]
  stop(): Promise<void>
}

export async function startEgress(workdir: string, policy: Policy, gate: Gate): Promise<Egress> {
  await SandboxManager.initialize(compileSrt(policy, gate), undefined, false)
  const port = SandboxManager.getProxyPort()
  const token = SandboxManager.getProxyAuthToken()
  if (!port || !token) {
    await SandboxManager.reset()
    throw new Error('vm: the sandbox proxy did not start')
  }
  const path = vmProxySocket(workdir)
  await rm(path, { force: true })
  const sockets = new Set<net.Socket>()
  // srt listens on "localhost"; connect the same way rather than guessing 127.0.0.1 or ::1.
  const server = net.createServer(guest => {
    const up = net.connect({ host: 'localhost', port })
    for (const s of [guest, up]) {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.on('error', () => s.destroy())
    }
    guest.pipe(up)
    up.pipe(guest)
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve))

  const url = `http://srt:${token}@${L2_PROXY}`
  return {
    env: {
      ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].map(k => [k, url])),
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1',
      ...Object.fromEntries(['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'AWS_CA_BUNDLE'].map(k => [k, L2_CA])),
    },
    ca: SandboxManager.getMitmCA()?.certPem ?? '',
    denials: since =>
      SandboxManager.getSandboxViolationStore()
        .getViolations()
        .filter(v => v.timestamp >= since && notGated(v))
        .map(toEffect),
    async stop() {
      // Stop accepting first, so a background process gets the envgit 503 rather than a half-open tunnel.
      const closed = new Promise<void>(r => server.close(() => r()))
      for (const s of sockets) s.destroy()
      await closed
      await rm(path, { force: true })
      await SandboxManager.reset()
    },
  }
}
