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
    const curl = (host: string, body: string) => `curl -sS --noproxy '' -H "Authorization: Bearer $API_TOKEN" -d "${body}" "https://${host}:${port}/echo?q=$API_TOKEN"`
    const r = await envgit(['run', 'sh', '-c', `${curl('127.0.0.1', 'note=hello')} && echo && ${curl('localhost', 'note=$API_TOKEN')}`])
    expect(r.stdout).toBe('ok\nok')
    const [inject, other] = seen
    // Its own host: the header carries the real value.
    expect(inject!.auth).toBe(`Bearer ${REAL}`)
    expect(inject!.body).toBe('note=hello')
    // Not in the URL: a query string keeps the stand-in (and so stays out of the server's access log).
    expect(inject!.url).toMatch(/^\/echo\?q=fake_value_/)
    // Another allowed host gets the stand-in everywhere, body included: useless there.
    expect(other!.auth).toMatch(/^Bearer fake_value_/)
    expect(other!.body).toMatch(/^note=fake_value_/)
    expect(JSON.stringify(other)).not.toContain(REAL)
    expect(r.stdout + r.stderr).not.toContain(REAL)
  }, 60_000)

  it('refuses a body that carries the stand-in to its own host, where the proxy would put the real value', async () => {
    seen.length = 0
    // A host that echoes what it is sent would hand the value back; the request never leaves.
    const big = 'x'.repeat(3 << 20) // past the gate's 1 MB body limit: scanned all the same
    await writeFile(join(dir, 'big.txt'), `${big}`)
    const script = [
      `curl -sS --noproxy '' -w ' %{http_code}' -d "note=$API_TOKEN" "https://127.0.0.1:${port}/echo"; echo`,
      `printf '%s%s' "$(cat big.txt)" "$API_TOKEN" | curl -sS --noproxy '' -w ' %{http_code}' --data-binary @- "https://127.0.0.1:${port}/echo"; echo`,
      // A GET can carry a body too, which the gate is not shown: refused while a stand-in could be in it.
      `curl -sS --noproxy '' -w ' %{http_code}' -X GET -d "note=$API_TOKEN" "https://127.0.0.1:${port}/echo"; echo`,
      // A credential in a header is what it is for.
      `curl -sS --noproxy '' -w ' %{http_code}' -H "Authorization: Bearer $API_TOKEN" "https://127.0.0.1:${port}/echo"; echo`,
    ].join('\n')
    const r = await envgit(['run', 'sh', '-c', script])
    // Each refusal comes back as a 403 whose body is envgit's reason.
    expect(r.stdout.match(/^ 403$/gm)).toHaveLength(3)
    expect(r.stdout.match(/carries a credential's stand-in in its body/g)).toHaveLength(3)
    expect(r.stdout).toMatch(/^ok 200$/m)
    expect(seen.map(s => s.body)).toEqual([''])
    expect(seen[0]!.auth).toBe(`Bearer ${REAL}`)
    expect(r.stderr).toMatch(/carries a credential's stand-in in its body/)
    expect(r.stdout + r.stderr).not.toContain(REAL)
  }, 60_000)

  it("keeps a credential that came in through the environment out of every process record the sandbox can read", async () => {
    // macOS: another process's start-up environment, by sysctl kern.procargs2 (envgit's pid is handed in).
    // Linux: every /proc/<pid>/environ the sandbox can see. Prints only whether the value was found.
    const probe = join(dir, 'probe.py')
    await writeFile(
      probe,
      `import ctypes, os, sys
needle = open('needle.txt', 'rb').read().strip()
pid = int(os.environ.get('PROBE_PID', '0'))
found = []
if sys.platform == 'darwin':
    libc = ctypes.CDLL(None)
    for p in [pid, os.getppid()]:
        mib = (ctypes.c_int * 3)(1, 49, p)
        size = ctypes.c_size_t(1 << 20)
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0 and needle in buf.raw[:size.value]:
            found.append(p)
else:
    for d in os.listdir('/proc'):
        if d.isdigit():
            try:
                if needle in open('/proc/%s/environ' % d, 'rb').read(): found.append(int(d))
            except OSError:
                pass
print('found' if found else 'not found', len(found))
`,
    )
    const value = `${REAL}-from-env`
    // In a file, not on the command line: envgit's own argv is in the same record the probe reads.
    await writeFile(join(dir, 'needle.txt'), value)
    // exec keeps the pid: PROBE_PID is envgit's, before and after it restarts itself.
    const go = (extra: NodeJS.ProcessEnv) =>
      run('sh', ['-c', `PROBE_PID=$$ exec "${process.execPath}" "${CLI}" run python3 probe.py`], { cwd: dir, env: { ...process.env, FROM_ENV: value, ...extra } }).catch(
        (e: { stdout: string; stderr: string }) => e,
      )
    const r = await go({})
    expect(r.stdout).toMatch(/^not found 0$/m)
    expect(r.stderr).not.toContain(value)
    if (process.platform === 'darwin') {
      // The control: with the restart turned off, the same probe does find it, so the probe can see.
      const control = await go({ ENVGIT_CREDENTIAL_STASH: '' })
      expect(control.stdout).toMatch(/^found [1-9]/m)
    }
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
