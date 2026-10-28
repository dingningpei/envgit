import { describe, expect, it } from 'vitest'
import { Gate, irreversibleOf, judgeNet, judgeShell, needsInspection } from '../src/core/policy/gate.js'
import type { Policy } from '../src/core/policy/schema.js'

const policy: Policy = {
  network: { l7: { 'api.github.com': { methods: ['GET'] } } },
  irreversible: [
    { net: { host: 'github.com', method: 'POST', path: '/**/git-receive-pack' } },
    { net: { host: '*.npmjs.org', method: 'PUT' }, action: 'deny' },
    { net: { host: 'hooks.example.com:8443' }, action: 'allow' },
    { shell: ['git push'] },
  ],
}
const req = (method: string, host: string, path: string, port = 443) => ({ method, host, port, path })
const request = (method: string, url: string) => new Request(url, { method })

describe('judgeNet', () => {
  it('matches host, method and path globs', () => {
    expect(judgeNet(policy, req('POST', 'github.com', '/acme/app.git/git-receive-pack'))).toMatchObject({ action: 'ask' })
    expect(judgeNet(policy, req('POST', 'github.com', '/acme/app.git/git-upload-pack'))).toEqual({ action: 'pass' })
    expect(judgeNet(policy, req('GET', 'github.com', '/acme/app.git/git-receive-pack'))).toEqual({ action: 'pass' })
    expect(judgeNet(policy, req('PUT', 'registry.npmjs.org', '/pkg'))).toMatchObject({ action: 'deny', rule: 'net PUT *.npmjs.org **' })
    expect(judgeNet(policy, req('POST', 'hooks.example.com', '/x', 8443))).toMatchObject({ action: 'allow' })
    expect(judgeNet(policy, req('POST', 'hooks.example.com', '/x', 443))).toEqual({ action: 'pass' })
  })

  it('denies what network.l7 does not list, before irreversible rules', () => {
    expect(judgeNet(policy, req('GET', 'api.github.com', '/zen'))).toEqual({ action: 'pass' })
    const v = judgeNet(policy, req('post', 'API.github.com', '/repos/a/b/issues'))
    expect(v).toMatchObject({ action: 'deny' })
    expect((v as { reason: string }).reason).toMatch(/not allowed by network.l7/)
  })

  it('a single * does not cross a path segment', () => {
    const p: Policy = { irreversible: [{ net: { host: 'x', path: '/repos/*/issues' } }] }
    expect(judgeNet(p, req('POST', 'x', '/repos/a/issues')).action).toBe('ask')
    expect(judgeNet(p, req('POST', 'x', '/repos/a/b/issues')).action).toBe('pass')
  })

  it('takes any of several methods or paths', () => {
    const p: Policy = { irreversible: [{ net: { host: 'x', method: ['put', 'DELETE'], path: ['/a/**', '/b'] }, name: 'writes' }] }
    expect(judgeNet(p, req('PUT', 'x', '/a/1/2'))).toEqual({ action: 'ask', rule: 'writes' })
    expect(judgeNet(p, req('DELETE', 'x', '/b')).action).toBe('ask')
    expect(judgeNet(p, req('POST', 'x', '/b')).action).toBe('pass')
    expect(judgeNet(p, req('PUT', 'x', '/c')).action).toBe('pass')
    expect(judgeNet({ irreversible: [{ net: { host: 'x', method: ['PUT', 'DELETE'], path: ['/a/**', '/b'] } }] }, req('PUT', 'x', '/b'))).toMatchObject({ rule: 'net PUT|DELETE x /a/**|/b' })
  })

  it('knows when inspection is needed', () => {
    expect(needsInspection(policy)).toBe(true)
    expect(needsInspection({ irreversible: [{ shell: ['x'] }] })).toBe(false)
  })
})

describe('Gate', () => {
  it('asks, and records what was approved or denied', async () => {
    const asked: string[] = []
    let answer = true
    const gate = new Gate(policy, async r => (asked.push(r.action), answer), 'test')
    const ok = await gate.filterRequest(request('POST', 'https://github.com/a/b.git/git-receive-pack'))
    expect(ok.action).toBe('allow')
    answer = false
    const no = await gate.filterRequest(request('POST', 'https://github.com/a/b.git/git-receive-pack'))
    expect(no).toMatchObject({ action: 'deny' })
    expect(no.reason).toMatch(/was not approved/)
    expect(asked).toEqual(['POST github.com/a/b.git/git-receive-pack', 'POST github.com/a/b.git/git-receive-pack'])
    const effects = gate.drain()
    expect(effects.map(e => e.kind === 'net' && e.irreversible?.decision)).toEqual(['approved', 'denied'])
    expect(irreversibleOf(effects)).toMatch(/^net POST github.com .*approved\)$/)
    expect(gate.drain()).toEqual([])
  })

  it('denies an ask rule when no one can be asked, saying how to allow it', async () => {
    const gate = new Gate(policy)
    const d = await gate.filterRequest(request('POST', 'https://github.com/a/b.git/git-receive-pack'))
    expect(d.action).toBe('deny')
    expect(d.reason).toMatch(/needs approval, but there is nobody to ask .*action: allow/)
  })

  it('treats an approver that throws as a denial', async () => {
    const gate = new Gate(policy, async () => {
      throw new Error('dialog closed')
    }, 'test')
    expect((await gate.filterRequest(request('POST', 'https://github.com/a/b.git/git-receive-pack'))).action).toBe('deny')
  })

  it('passes unmatched requests without recording them', async () => {
    const gate = new Gate(policy)
    expect((await gate.filterRequest(request('GET', 'https://example.org/'))).action).toBe('allow')
    expect(gate.drain()).toEqual([])
  })

  it('gates shell rules before a command starts', async () => {
    expect(judgeShell(policy, ['git', 'push', 'origin'])).toMatchObject({ action: 'ask' })
    expect(judgeShell(policy, ['git', 'pushx'])).toBeUndefined()
    // Agents wrap every command in a shell; the script's own commands are judged too.
    expect(judgeShell(policy, ['/bin/zsh', '-lc', 'git add -A\ngit commit -m x && git  push origin'])).toMatchObject({ rule: 'shell: git push' })
    expect(judgeShell(policy, ['bash', '-c', 'echo git push'])).toBeUndefined()
    expect(judgeShell(policy, ['python3', '-c', 'git push'])).toBeUndefined()
    expect((await new Gate(policy).checkShell(['git', 'push'])).refused).toMatch(/needs approval/)
    expect(await new Gate(policy, async () => true, 't').checkShell(['git', 'push'])).toEqual({ irreversible: 'shell: git push' })
    expect(await new Gate(policy).checkShell(['ls'])).toEqual({})
  })
})
