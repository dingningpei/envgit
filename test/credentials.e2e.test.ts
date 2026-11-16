import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const REAL = 'real-secret-0123456789abcdefghijklmnop'

/** A CA and a server certificate for 127.0.0.1 and localhost: two names for one server, one of them an inject host. */
async function testCa(dir: string) {
  const ssl = (...args: string[]) => run('openssl', args, { cwd: dir })
  await ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=envgit test CA')
  await ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1')
  await writeFile(join(dir, 'san.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n')
  await ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'san.ext')
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('credentials kept outside the sandbox (e2e, needs `npm run build`)', () => {
  let ca: string
  let dir: string
  let server: Server
  let port: number
  let tokenFile: string
  /** What the server was sent, per request: the only place the real value may show up. */
  const seen: { host: string; url: string; auth: string; body: string }[] = []
  const envgit = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    // The proxy terminates TLS, so the upstream is verified by envgit's own process: it has to trust the test CA.
    run(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(ca, 'ca.pem'), ...env } }).catch((e: { code: number; stdout: string; stderr: string }) => e)

  beforeAll(async () => {
    ca = await realpath(await mkdtemp(join(tmpdir(), 'envgit-cred-ca-')))
    await testCa(ca)
    server = createServer({ key: await readFile(join(ca, 'server.key')), cert: await readFile(join(ca, 'server.pem')) }, (req, res) => {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        seen.push({ host: String(req.headers.host), url: String(req.url), auth: String(req.headers.authorization ?? ''), body })
        res.end('ok')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
    tokenFile = join(ca, 'token')
    await writeFile(tokenFile, REAL + '\n', { mode: 0o600 })
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-cred-')))
    await envgit(['init'])
    await writeFile(
      join(dir, '.envgit/policy.yaml'),
      `filesystem:\n  write: { allow: ["."] }\nnetwork:\n  allow: ["127.0.0.1", "localhost"]\ncredentials:\n  API_TOKEN:\n    hosts: ["127.0.0.1"]\n    file: ${tokenFile}\n  FROM_ENV: { hosts: ["127.0.0.1"] }\n  NOT_SET: { hosts: ["127.0.0.1"] }\n`,
    )
  }, 60_000)
  afterAll(() => new Promise<void>(r => server.close(() => r())))

  it('gives the sandbox a stand-in, not the value, the file or the variable it came in', async () => {
    const script = `echo "token=$API_TOKEN"; echo "env=$FROM_ENV"; echo "unset=[\${NOT_SET-none}]"; cat ${tokenFile} 2>&1; env | grep -c '${REAL}'`
    const r = await envgit(['run', 'sh', '-c', script], { FROM_ENV: REAL + '-env' })
    expect(r.stdout).not.toContain(REAL)
    expect(r.stdout).toMatch(/^token=fake_value_\S+$/m)
    expect(r.stdout).toMatch(/^env=fake_value_\S+$/m)
    expect(r.stdout).toMatch(/^unset=\[none\]$/m)
    // (`cat` of the source file fails on macOS and reads an empty stand-in file on Linux: either way, not the value.)
    expect(r.stdout.trim().split('\n').at(-1)).toBe('0')
    expect(r.stderr).toMatch(/envgit: API_TOKEN stays outside the sandbox; sent only to 127\.0\.0\.1/)
    expect(r.stderr).toMatch(/envgit: credentials\.NOT_SET has no value/)
    expect(r.stderr).not.toContain(REAL)
  }, 60_000)

  it('puts the value back on a request to its host, and nowhere else', async () => {
    seen.length = 0
    const curl = (host: string) => `curl -sS --noproxy '' -H "Authorization: Bearer $API_TOKEN" -d "note=$API_TOKEN" "https://${host}:${port}/echo?q=$API_TOKEN"`
    const r = await envgit(['run', 'sh', '-c', `${curl('127.0.0.1')} && echo && ${curl('localhost')}`])
    expect(r.stdout).toBe('ok\nok')
    const [inject, other] = seen
    // Its own host: the header carries the real value. So does the body: the proxy substitutes there
    // too, which is why a host on the list must not be one that hands back what it is sent.
    expect(inject!.auth).toBe(`Bearer ${REAL}`)
    expect(inject!.body).toBe(`note=${REAL}`)
    // Not in the URL: a query string keeps the stand-in (and so stays out of the server's access log).
    expect(inject!.url).toMatch(/^\/echo\?q=fake_value_/)
    // Another allowed host gets the stand-in everywhere: useless there.
    expect(other!.auth).toMatch(/^Bearer fake_value_/)
    expect(other!.body).toMatch(/^note=fake_value_/)
    expect(JSON.stringify(other)).not.toContain(REAL)
    expect(r.stdout + r.stderr).not.toContain(REAL)
  }, 60_000)

  it('refuses a policy that holds the value, or names no host', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'envgit-cred-bad-')))
    await run(process.execPath, [CLI, 'init'], { cwd: other })
    const bad = async (yaml: string) => {
      await writeFile(join(other, '.envgit/policy.yaml'), yaml)
      return (await run(process.execPath, [CLI, 'run', 'true'], { cwd: other }).catch((e: { stderr: string }) => e)).stderr
    }
    expect(await bad('credentials:\n  T: { hosts: ["a.example"], value: "x" }\n')).toMatch(/credentials\.T must not hold the value itself/)
    expect(await bad('credentials:\n  T: { hosts: [] }\n')).toMatch(/credentials\.T needs hosts/)
    expect(await bad('backend: vm\ncredentials:\n  T: { hosts: ["a.example"] }\n')).toMatch(/backend: vm does not support them yet/)
  }, 60_000)
})
