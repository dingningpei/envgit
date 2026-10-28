import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const POLICY = `filesystem:
  read: { allow: ["."] }
  write: { allow: ["."] }
`

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit show / diff (e2e, needs `npm run build`)', () => {
  let dir: string
  const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir })
  const fails = (...args: string[]) => envgit(...args).then(() => '', (e: { code: number; stderr: string }) => `${e.code} ${e.stderr.trim()}`)

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-show-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), POLICY)
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await envgit('run', 'sh', '-c', "printf 'one\\n2\\nthree\\n' > a.txt; echo new > b.txt")
    await envgit('run', 'rm', 'b.txt')
  }, 60_000)

  it('shows a step: its action, effects, and the diff against its parent', async () => {
    const { stdout } = await envgit('show', '0')
    expect(stdout).toMatch(/^step 0 {2}\(session \S+\)\naction: +exec {2}sh -c printf/)
    expect(stdout).toMatch(/\nparent: +base\n/)
    expect(stdout).toMatch(/\neffects:\n {2}write a\.txt\n {2}write b\.txt\n/)
    expect(stdout).toContain('--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n')
    expect(stdout).toContain('new file\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,1 @@\n+new\n')
    const s1 = (await envgit('show', '1')).stdout
    expect(s1).toMatch(/\nparent: +0\n/)
    expect(s1).toContain('deleted file\n--- a/b.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-new\n')
    expect(s1).not.toContain('a.txt')
  })

  it('diffs any two steps or base, as a patch git applies', async () => {
    const { stdout } = await envgit('diff', 'base', '1')
    expect(stdout).toBe('diff a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n')
    expect((await envgit('diff', '1', '1')).stdout).toBe('')
    const back = (await envgit('diff', '0', 'base')).stdout
    expect(back).toContain('-2\n+two\n')
    expect(back).toContain('deleted file\n--- a/b.txt\n+++ /dev/null\n')
    // The workdir is at step 1: reversing base → 1 gives base's a.txt back.
    await writeFile(join(dir, 'p.diff'), stdout)
    await run('git', ['apply', '--reverse', 'p.diff'], { cwd: dir })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('reads another session with --session, and says what is wrong otherwise', async () => {
    const id = (await readFile(join(dir, '.envgit', 'current'), 'utf8')).trim()
    expect((await envgit('show', '1', '--session', id)).stdout).toContain(`(session ${id})`)
    expect(await fails('show', '7')).toMatch(/^1 envgit: session \S+ has no step 7 \(it has 2\)$/)
    expect(await fails('show', 'base')).toMatch(/^1 envgit: usage: envgit show/)
    expect(await fails('diff', '0')).toMatch(/^1 envgit: usage: envgit diff/)
    expect(await fails('diff', '0', '9')).toBe('1 envgit: step 9 has no snapshot')
    expect(await fails('show', '0', '--session', 'nope')).toBe('1 envgit: no session nope (see .envgit/sessions)')
  })
})
