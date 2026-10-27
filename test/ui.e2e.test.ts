import { execFile, spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)
const POLICY = `filesystem:
  read: { allow: ["."] }
  write: { allow: ["."] }
`

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit ui (e2e, needs `npm run build`)', () => {
  let dir: string
  let ui: ChildProcess
  let url: string
  const envgit = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir })
  const get = async (path: string) => (await fetch(url + path)).json()
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-envgit-token': new URL(url).pathname.split('/')[1]!, ...headers }, body: JSON.stringify(body) })

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-ui-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await writeFile(join(dir, '.envgit', 'policy.yaml'), POLICY)
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await envgit('run', 'sh', '-c', "printf 'one\\n2\\nthree\\n' > a.txt; echo new > b.txt")
    await envgit('run', 'rm', 'b.txt')
    ui = spawn(process.execPath, [CLI, 'ui', '--port', '0'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
    url = await new Promise<string>((resolve, reject) => {
      let err = ''
      ui.stderr!.on('data', (d: Buffer) => {
        err += d
        const m = /timeline at (\S+)/.exec(err)
        if (m) resolve(m[1]!)
      })
      ui.once('exit', () => reject(new Error(err)))
    })
  }, 60_000)

  afterAll(() => {
    ui?.kill('SIGINT')
  })

  it('serves the page and the session state', async () => {
    expect(await (await fetch(url)).text()).toMatch(/<title>envgit timeline<\/title>/)
    const s = await get('api/state')
    expect(s.workdir).toBe(dir)
    expect(s.session.head).toBe(1)
    expect(s.session.chain).toEqual([0, 1])
    expect(s.session.steps.map((st: { action: { input: string } }) => JSON.parse(st.action.input)[0])).toEqual(['sh', 'rm'])
  })

  it('shows what each step changed, as diffs against its parent', async () => {
    const d0 = await get(`api/diff?session=${(await get('api/state')).current}&step=0`)
    expect(d0.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`)).toEqual(['modified a.txt', 'added b.txt'])
    expect(d0.files[0].hunks[0]).toEqual({ header: '@@ -1,3 +1,3 @@', lines: [' one', '-two', '+2', ' three'] })
    expect(d0.files[1].hunks[0].lines).toEqual(['+new'])
    const d1 = await get(`api/diff?session=${(await get('api/state')).current}&step=1`)
    expect(d1.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`)).toEqual(['deleted b.txt'])
  })

  it('refuses calls without the token, the token header, or this host', async () => {
    const origin = new URL(url).origin
    expect((await fetch(`${origin}/api/state`)).status).toBe(404)
    expect((await fetch(url + 'api/rewind', { method: 'POST', body: '{"step":0}' })).status).toBe(403)
    const status = await new Promise<number>(resolve => {
      const u = new URL(url + 'api/state')
      http.get({ host: '127.0.0.1', port: u.port, path: u.pathname, headers: { host: `evil.example:${u.port}` } }, r => (r.resume(), resolve(r.statusCode!)))
    })
    expect(status).toBe(403)
  })

  it('rewinds through the CLI, asking for a second click to drop unrecorded edits', async () => {
    await writeFile(join(dir, 'a.txt'), 'edited outside envgit\n')
    const refused = await (await post('api/rewind', { step: 0 })).json()
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/rewind --force discards them/)
    const forced = await (await post('api/rewind', { step: 0, force: true })).json()
    expect(forced.code).toBe(0)
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('new\n')
    expect((await get('api/state')).session.head).toBe(0)
  }, 30_000)

  it('forks a step into a new directory', async () => {
    const target = `${dir}-fork`
    const r = await (await post('api/fork', { step: 'base', dir: target })).json()
    expect(r.code).toBe(0)
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  }, 30_000)
})
