import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s

// A git smart-HTTP remote on loopback that advertises an empty repo, so `git push` gets as far as
// sending its pack: the request the stock `git push` rule is for, from a real git client.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('the default preset (e2e, needs `npm run build`)', () => {
  let dir: string
  let server: http.Server
  let remote: string
  const hits: string[] = []
  const envgit = (...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)

  beforeAll(async () => {
    server = http.createServer((q, r) => {
      hits.push(`${q.method} ${q.url}`)
      if (q.url?.endsWith('/info/refs?service=git-receive-pack')) {
        r.setHeader('content-type', 'application/x-git-receive-pack-advertisement')
        r.end(`${pkt('# service=git-receive-pack\n')}0000${pkt(`${'0'.repeat(40)} capabilities^{}\0report-status\n`)}0000`)
      } else if (q.url === '/graphql') r.end('{"data":{}}')
      else r.end(`${pkt('unpack ok\n')}0000`)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/app.git`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-preset-')))
    await envgit('init')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'network:\n  allow: ["127.0.0.1"]\nfilesystem:\n  write: { allow: ["."] }\nirreversible:\n' +
        // The preset's GraphQL rules name GitHub and GitLab; the same rule shape, for this server.
        '  - net: { host: "127.0.0.1", method: POST, path: /graphql, body: { contains: mutation } }\n    name: graphql mutation\n  - preset: default\n')
    const git = (...a: string[]) => run('git', a, { cwd: dir })
    await git('init', '-q', '-b', 'main')
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  }, 30_000)

  afterAll(() => server?.close())

  it('stops git push at the HTTPS request, past the command-line rule', async () => {
    // `$g push` is not the text `git push`: the shell rule cannot see it; the request rule does. (The
    // sandbox exempts loopback from the proxy; cleared so this local remote stands in for a real one.)
    const r = await envgit('run', 'sh', '-c', `g=git; NO_PROXY= no_proxy= $g -c credential.helper= push ${remote} main`)
    expect(r.stderr).toMatch(/HTTP 403/)
    expect(r.stderr).toMatch(/envgit: denied POST 127\.0\.0\.1\/acme\/app\.git\/git-receive-pack \(git push\)/)
    expect(hits).toContain('GET /acme/app.git/info/refs?service=git-receive-pack')
    expect(hits).not.toContain('POST /acme/app.git/git-receive-pack')
  }, 60_000)

  it('stops the plain command line before it starts', async () => {
    const before = hits.length
    const r = await envgit('run', 'git', 'push', remote, 'main')
    expect(r.stderr).toMatch(/is irreversible \(shell: git push\)/)
    expect(hits.length).toBe(before)
  }, 60_000)

  it('stops git over SSH at the proxy, and ssh prints why', async () => {
    const r = await envgit('run', 'git', 'ls-remote', 'ssh://git@127.0.0.1/acme/app.git')
    expect(r.stderr).toMatch(/refused by irreversible rule "git push over SSH".*use an https:\/\/ remote/)
  }, 60_000)

  it('reads a GraphQL body: a mutation is stopped, a query goes through', async () => {
    const gql = (q: string) => envgit('run', 'curl', '-s', '--noproxy', '', '-w', ' %{http_code}', '-X', 'POST', '--data', JSON.stringify({ query: q }), `${remote.replace('/acme/app.git', '')}/graphql`)
    const before = hits.length
    expect((await gql('mutation { addStar }')).stdout).toMatch(/irreversible \(graphql mutation\)[^]*403$/)
    expect(hits.length).toBe(before)
    expect((await gql('query { viewer { login } }')).stdout).toBe('{"data":{}} 200')
    expect(hits.at(-1)).toBe('POST /graphql')
  }, 60_000)
})

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('unix sockets and the preset (e2e, needs `npm run build`)', () => {
  // macOS caps socket paths near 104 bytes, so not under the test's temp dir.
  const sock = `/tmp/envgit-e2e-${process.pid}.sock`
  let server: net.Server
  let dir: string
  const envgit = (...args: string[]) =>
    run(process.execPath, [CLI, ...args], { cwd: dir }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  const policy = (rules: string) => writeFile(join(dir, '.envgit/policy.yaml'), `network:\n  allowUnixSockets: ["${sock}"]\nirreversible:\n${rules}  - preset: default\n`)
  const connect = ['node', '-e', `require('net').connect(${JSON.stringify(sock)}).on('data', d => console.log(String(d))).on('error', e => console.log(e.code))`]

  beforeAll(async () => {
    await rm(sock, { force: true })
    server = net.createServer(c => c.end('daemon'))
    await new Promise<void>(r => server.listen(sock, r))
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-sock-')))
    await envgit('init')
  }, 30_000)

  afterAll(() => server?.close())

  it('keeps a socket out unless the policy names it', async () => {
    expect((await envgit('run', ...connect)).stdout.trim()).toBe('EPERM')
  }, 30_000)

  it('refuses a policy that lets in a socket a rule guards, and lets it in when a rule allows it', async () => {
    await policy(`  - socket: ["**/envgit-e2e-*.sock"]\n    name: test daemon\n`)
    const r = await envgit('run', 'true')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/would let the sandbox reach what irreversible rule "test daemon" guards/)
    // On Linux every socket rule applies (srt lets in all sockets or none), the preset's docker rule too.
    await policy(`  - socket: ["**"]\n    action: allow\n`)
    expect((await envgit('run', ...connect)).stdout.trim()).toBe('daemon')
  }, 30_000)
})
