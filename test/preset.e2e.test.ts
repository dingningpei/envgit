import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
      } else r.end(`${pkt('unpack ok\n')}0000`)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/app.git`
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-preset-')))
    await envgit('init')
    await writeFile(join(dir, '.envgit/policy.yaml'), 'network:\n  allow: ["127.0.0.1"]\nfilesystem:\n  write: { allow: ["."] }\nirreversible:\n  - preset: default\n')
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
})
