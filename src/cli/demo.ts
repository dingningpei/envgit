/**
 * `envgit demo`: thirty seconds in a temporary directory with a scripted stand-in for an agent
 * (docs/design.md §5 M7). Five steps, a `git push` refused at the request on the fourth, a rewind.
 * No API key and no agent: the steps are fixed command lines, run through the real `envgit run`.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s

const POLICY = `filesystem:
  write: { allow: ["."] }
network:
  allow: ["127.0.0.1"]
irreversible:
  - preset: default
    action: deny        # nobody at a terminal to ask
`

const GREET = `console.log('hello, ' + (process.argv[2] ?? 'world'))
`

// The shell rule sees \`sh release.sh\`, not the push inside it; the request rule sees the push.
const RELEASE = `#!/bin/sh
# Ship it: check the script runs, then push.
node greet.js > /dev/null || exit 1
# The sandbox lets loopback bypass its proxy, and this demo's remote is on loopback; a real remote
# goes through the proxy without this line.
NO_PROXY= no_proxy= git push origin main
`

const STEPS: { says: string; argv: string[] }[] = [
  { says: 'write greet.js', argv: ['sh', '-c', `cat > greet.js <<'EOF'\n${GREET}EOF`] },
  { says: 'try it', argv: ['node', 'greet.js', 'envgit'] },
  { says: 'commit it', argv: ['sh', '-c', 'git add greet.js && git commit -q -m "add greet.js" && git log --oneline -1'] },
  { says: 'release it', argv: ['sh', 'release.sh'] },
  { says: 'the push failed, so start over', argv: ['sh', '-c', 'git reset -q --hard HEAD~1 && ls'] },
]
const REWIND_TO = 2

export async function demo(args: string[]): Promise<number> {
  const keep = args.includes('--keep')
  const color = process.stdout.isTTY
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s)
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s)
  const t0 = Date.now()

  // A git smart-HTTP remote on loopback that advertises an empty repo, so `git push` gets as far as
  // sending its pack (as in test/preset.e2e.test.ts). It records what reaches it.
  const hits: string[] = []
  const server = http.createServer((q, r) => {
    hits.push(`${q.method} ${q.url}`)
    if (q.url?.endsWith('/info/refs?service=git-receive-pack')) {
      r.setHeader('content-type', 'application/x-git-receive-pack-advertisement')
      r.end(`${pkt('# service=git-receive-pack\n')}0000${pkt(`${'0'.repeat(40)} capabilities^{}\0report-status\n`)}0000`)
    } else r.end(`${pkt('unpack ok\n')}0000`)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/demo/app.git`
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-demo-')))

  // This process's own CLI, under the same node flags (tsx in `npm run dev`).
  const self = [...process.execArgv, process.argv[1]!]
  const envgit = (argv: string[]) =>
    new Promise<number>((resolve, reject) => {
      const p = spawn(process.execPath, [...self, ...argv], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      const indent = (s: Buffer) => process.stdout.write(String(s).replace(/^(?=.)/gm, '    '))
      p.stdout.on('data', indent)
      p.stderr.on('data', indent)
      p.on('error', reject)
      p.on('close', c => resolve(c ?? 1))
    })
  const git = (...a: string[]) => exec('git', a, { cwd: dir }).then(r => r.stdout)
  const quote = (a: string) => (/^[\w./=-]+$/.test(a) ? a : /["$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : `"${a}"`)
  const show = (argv: string[]) => argv.map(quote).join(' ').replace(/\n/g, '\n      ')
  const out = (s: string) => process.stdout.write(s.replace(/^(?=.)/gm, '    '))

  try {
    console.log(bold('envgit demo') + dim(` — a scripted agent in ${dir}`))
    console.log(dim(`  a git repo whose origin is a local smart-HTTP remote (${remote}),`))
    console.log(dim('  policy: write the workdir, reach 127.0.0.1, refuse the stock irreversible actions'))
    if ((await envgit(['init'])) !== 0) throw new Error('envgit init failed')
    await writeFile(join(dir, '.envgit/policy.yaml'), POLICY)
    await git('init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'demo'], ['user.email', 'demo@example.com'], ['credential.helper', ''], ['commit.gpgsign', 'false']])
      await git('config', k!, v!)
    await git('remote', 'add', 'origin', remote)
    await writeFile(join(dir, '.gitignore'), '.envgit/\n')
    await writeFile(join(dir, 'release.sh'), RELEASE)
    await git('add', '.gitignore', 'release.sh')
    await git('commit', '-q', '-m', 'release script')

    for (const [i, st] of STEPS.entries()) {
      console.log(`\n${bold(`step ${i}`)}  agent: ${st.says}`)
      console.log(`  $ envgit run ${show(st.argv)}`)
      const before = hits.length
      const code = await envgit(['run', ...st.argv])
      if (i === 3) {
        const seen = hits.slice(before)
        console.log(dim(`  the remote saw: ${seen.length ? seen.join(', ') : 'nothing'}`))
        if (seen.some(h => h.startsWith('POST '))) throw new Error('the push reached the remote; the demo expected it refused')
        console.log(dim('  the ref advertisement went through; the pack, POST …/git-receive-pack, never arrived'))
      } else if (code !== 0) throw new Error(`step ${i} exited ${code}`)
    }

    console.log(`\n${bold('the timeline')}`)
    console.log('  $ envgit log')
    await envgit(['log'])
    console.log(`\n${bold('rewind')} ${dim(`to step ${REWIND_TO}, before the push and the reset`)}`)
    console.log(`  $ envgit rewind ${REWIND_TO}`)
    if ((await envgit(['rewind', String(REWIND_TO)])) !== 0) throw new Error('rewind failed')
    console.log('  $ git log --oneline && cat greet.js')
    out(await git('log', '--oneline'))
    out(await readFile(join(dir, 'greet.js'), 'utf8'))

    console.log(dim(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`))
    if (keep) console.log(`kept ${dir}: \`cd\` there and try \`envgit ui\`, \`envgit show 3\`, \`envgit log\`.`)
    else console.log(dim('`envgit demo --keep` keeps the directory to look around in (`envgit ui`, `envgit show 3`).'))
    return 0
  } finally {
    server.close()
    if (!keep) await rm(dir, { recursive: true, force: true })
  }
}
