import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '../src/core/snapshot/log.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const POLICY = fileURLToPath(new URL('../examples/policy.yaml', import.meta.url))

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit mcp (e2e, needs `npm run build`)', () => {
  let dir: string
  let client: Client

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-mcp-')))
    await mkdir(join(dir, '.envgit', 'sessions'), { recursive: true })
    await copyFile(POLICY, join(dir, '.envgit', 'policy.yaml'))
    client = new Client({ name: 'envgit-test', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: dir, stderr: 'ignore' }))
  }, 30_000)

  afterAll(async () => {
    await client?.close()
  })

  const execute = async (code: string) => {
    const r = await client.callTool({ name: 'execute', arguments: { code } })
    return { text: (r.content as { text: string }[])[0]!.text, isError: Boolean(r.isError) }
  }

  const steps = async (): Promise<Step[]> => {
    const sessions = join(dir, '.envgit', 'sessions')
    const [id] = await readdir(sessions)
    const text = await readFile(join(sessions, id!, 'steps.jsonl'), 'utf8')
    return text.trim().split('\n').map(l => JSON.parse(l) as Step)
  }

  it('describes the injected API', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(['execute'])
    expect(tools[0]!.description).toContain('declare const fs')
    expect(tools[0]!.description).toContain('getIssue')
  })

  it('keeps state across calls', async () => {
    expect((await execute('let x = 1; const { y } = { y: 41 }')).isError).toBe(false)
    expect((await execute('function inc(n) { return n + 1 }\nprint(x + 1)')).text).toMatch(/^2\n/)
    expect((await execute('await Promise.resolve(inc(y))')).text).toMatch(/^42\n/)
  }, 30_000)

  it('writes inside the workdir and logs fs effects', async () => {
    const r = await execute("await fs.writeFile('a.txt', 'hi'); await fs.readFile('a.txt')")
    expect(r.text).toMatch(/^hi\n/)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hi')
    const fsEffects = (await steps()).at(-1)!.effects.filter(e => e.kind === 'fs')
    expect(fsEffects).toEqual([
      { kind: 'fs', op: 'write', path: join(dir, 'a.txt') },
      { kind: 'fs', op: 'read', path: join(dir, 'a.txt') },
    ])
  }, 30_000)

  it('denies policy-protected reads and logs them on the right step', async () => {
    const ssh = join(homedir(), '.ssh')
    const r = await execute(`await fs.readdir(${JSON.stringify(ssh)})`)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`[sandbox denied]\nfs read ${ssh}`)
    const log = await steps()
    expect(log.map(s => s.action.type)).toEqual(Array(log.length).fill('repl'))
    const last = log.at(-1)!
    expect(last.exitCode).toBe(1)
    expect(last.effects).toContainEqual({ kind: 'fs', op: 'read', path: ssh, denied: true })
    expect(log.slice(0, -1).every(s => !s.effects.some(e => e.kind === 'fs' && e.path === ssh))).toBe(true)
  }, 30_000)
})
