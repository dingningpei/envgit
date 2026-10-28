import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

// A corporate CA the system does not know, signing a server on loopback.
async function corporateCa(dir: string) {
  const ssl = (...args: string[]) => run('openssl', args, { cwd: dir })
  await ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=envgit test corp CA')
  await ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1')
  await writeFile(join(dir, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n')
  await ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'san.ext')
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('network.extraCaCertPaths (e2e, needs `npm run build`)', () => {
  let ca: string
  let dir: string
  let server: Server
  let url: string
  // NO_PROXY cleared: srt lets loopback skip its proxy, and the sandbox then refuses the connection.
  const envgit = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env } }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  const policy = (extra: string) => writeFile(join(dir, '.envgit/policy.yaml'), `filesystem:\n  write: { allow: ["."] }\nnetwork:\n  allow: ["127.0.0.1"]\n${extra}`)
  const fetchIt = () => `fetch('${url}').then(r => r.text()).then(t => console.log('node:', t), e => console.log('node failed:', e.cause?.code))`

  beforeAll(async () => {
    ca = await realpath(await mkdtemp(join(tmpdir(), 'envgit-ca-test-')))
    await corporateCa(ca)
    server = createServer({ key: await readFile(join(ca, 'server.key')), cert: await readFile(join(ca, 'server.pem')) }, (_, res) => res.end('corp ok'))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `https://127.0.0.1:${(server.address() as { port: number }).port}/`
  }, 60_000)
  afterAll(() => new Promise<void>(r => server.close(() => r())))

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-ca-')))
    await envgit(['init'])
  })

  it('without it, the sandbox does not trust the corporate CA, NODE_USE_SYSTEM_CA or not', async () => {
    await policy('')
    const r = await envgit(['run', 'env', 'NO_PROXY=', 'no_proxy=', 'node', '-e', fetchIt()], { NODE_USE_SYSTEM_CA: '1' })
    expect(r.stdout).toMatch(/node failed: (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)/)
    expect(r.stderr).not.toMatch(/trust settings/)
  }, 60_000)

  it('with it, node and curl in the sandbox trust the corporate CA, and still the public roots', async () => {
    await policy(`  extraCaCertPaths: ["${join(ca, 'ca.pem')}"]\n`)
    const r = await envgit(['run', 'sh', '-c', `export NO_PROXY= no_proxy=; node -e "${fetchIt()}" && curl -sS ${url} && echo && grep -c 'BEGIN CERTIFICATE' "$SSL_CERT_FILE"`])
    expect(r.stdout).toContain('node: corp ok')
    expect(r.stdout).toMatch(/^corp ok$/m)
    // The system's roots plus the one added: public hosts keep verifying.
    expect(Number(r.stdout.trim().split('\n').at(-1))).toBeGreaterThan(10)
  }, 60_000)

  it('refuses a path it cannot read instead of skipping it', async () => {
    await policy(`  extraCaCertPaths: ["${join(ca, 'missing.pem')}"]\n`)
    const r = await envgit(['run', 'true'])
    expect(r.stderr).toMatch(/extraCaCertPaths: cannot read .*missing\.pem/)
  }, 60_000)
})
