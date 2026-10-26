/**
 * Egress for the vm backend (docs/design.md §3.6): while a step runs, envgit starts srt's proxy with
 * the policy's allowlist and the irreversible-action gate, and serves the unix socket envgit-vm
 * hands L2's proxy connections to. Between steps nothing listens, so L2 has no way out.
 *
 * What lasts across steps is what long-lived processes in L2 (the REPL worker, a dev server) bake
 * in at startup: a credential-free proxy URL — the L2 agent adds each step's token — and one CA per
 * workdir, generated once, so the bundle they trust stays valid.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { generateCa, SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { compileSrt } from '../policy/compile.js'
import type { Gate } from '../policy/gate.js'
import type { Policy } from '../policy/schema.js'
import type { Effect } from './backend.js'
import { notGated, toEffect } from './srt.js'
import { vmPaths, vmProxySocket } from './vm.js'

/** L2's side of the tunnel and its CA bundle (written by the agent's `trust` op). */
const L2_PROXY = 'http://127.0.0.1:3128'
const L2_CA = '/etc/envgit/ca.pem'

/** Environment for anything in L2 that should reach the network: stable for the VM's lifetime. */
export const L2_NET_ENV: Record<string, string> = {
  ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].map(k => [k, L2_PROXY])),
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  NODE_USE_ENV_PROXY: '1',
  ...Object.fromEntries(['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'AWS_CA_BUNDLE'].map(k => [k, L2_CA])),
}

/** The workdir's proxy CA, made on first use. Its key never leaves the host. */
async function workdirCa(workdir: string): Promise<{ certPath: string; keyPath: string; certPem: string }> {
  const dir = join(vmPaths(workdir).state, 'ca')
  const certPath = join(dir, 'ca.crt')
  const keyPath = join(dir, 'ca.key')
  let certPem = await readFile(certPath, 'utf8').catch(() => '')
  if (!certPem || !(await readFile(keyPath, 'utf8').catch(() => ''))) {
    const ca = generateCa({ cn: 'envgit vm egress CA' })
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(keyPath, ca.keyPem, { mode: 0o600 })
    await chmod(keyPath, 0o600)
    await writeFile(certPath, ca.certPem)
    certPem = ca.certPem
  }
  return { certPath, keyPath, certPem }
}

export interface Egress {
  /** This step's proxy credentials ("user:token"); the L2 agent adds them to each connection. */
  proxyAuth: string
  /** PEM to append to L2's roots: the workdir CA when TLS is terminated, else empty. */
  ca: string
  /** Host allowlist denials since `since`, as step effects. */
  denials(since: Date): Effect[]
  /** Opens / closes the tunnel to L2 (open after start); the proxy itself keeps running. */
  open(): Promise<void>
  close(): Promise<void>
  /** Closes the tunnel and shuts the proxy down. */
  stop(): Promise<void>
}

export async function startEgress(workdir: string, policy: Policy, gate: Gate): Promise<Egress> {
  const ca = await workdirCa(workdir)
  await SandboxManager.initialize(compileSrt(policy, gate, { ca }), undefined, false)
  const port = SandboxManager.getProxyPort()
  const token = SandboxManager.getProxyAuthToken()
  if (!port || !token) {
    await SandboxManager.reset()
    throw new Error('vm: the sandbox proxy did not start')
  }
  const path = vmProxySocket(workdir)
  const sockets = new Set<net.Socket>()
  let server: net.Server | undefined

  // The tunnel is open only while a step runs; srt's proxy (and its per-host certificate cache) can
  // stay up longer, e.g. for the whole of an `envgit mcp` session.
  const open = async () => {
    if (server) return
    await rm(path, { force: true })
    // srt listens on "localhost"; connect the same way rather than guessing 127.0.0.1 or ::1.
    const s = net.createServer(guest => {
      const up = net.connect({ host: 'localhost', port })
      for (const x of [guest, up]) {
        sockets.add(x)
        x.on('close', () => sockets.delete(x))
        x.on('error', () => x.destroy())
      }
      guest.pipe(up)
      up.pipe(guest)
    })
    await new Promise<void>((resolve, reject) => s.once('error', reject).listen(path, resolve))
    server = s
  }
  const close = async () => {
    if (!server) return
    // Stop accepting first, so a background process gets the envgit 503 rather than a half-open tunnel.
    const closed = new Promise<void>(r => server!.close(() => r()))
    server = undefined
    for (const x of sockets) x.destroy()
    await closed
    await rm(path, { force: true })
  }
  await open()

  return {
    proxyAuth: `srt:${token}`,
    ca: SandboxManager.getMitmCA() ? ca.certPem : '',
    denials: since =>
      SandboxManager.getSandboxViolationStore()
        .getViolations()
        .filter(v => v.timestamp >= since && notGated(v))
        .map(toEffect),
    open,
    close,
    async stop() {
      await close()
      await SandboxManager.reset()
    },
  }
}
