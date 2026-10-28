import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { compileSrt } from '../src/core/policy/compile.js'
import { Gate, judgeNet, judgeShell } from '../src/core/policy/gate.js'
import { loadPolicy } from '../src/core/policy/load.js'
import { PRESETS } from '../src/core/policy/presets.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../src/core/env/srt.js'

describe('compileSrt', () => {
  it('maps the example policy onto srt settings', async () => {
    const policy = await loadPolicy(fileURLToPath(new URL('../examples/policy.yaml', import.meta.url)))
    expect(compileSrt(policy)).toEqual({
      network: {
        allowedDomains: ['api.github.com:443', 'registry.npmjs.org'],
        deniedDomains: ['*:22'],
        deniedDomainReasons: { '*:22': expect.stringMatching(/"git push over SSH".*use an https:\/\/ remote/) },
      },
      filesystem: {
        denyRead: ['~/.ssh', '~/.aws', '**/.env'],
        allowRead: ['.'],
        allowWrite: ['.', '/tmp'],
        denyWrite: ['.env', '.envgit'],
      },
    })
  })

  it('defaults to no network and no writes', () => {
    expect(compileSrt({})).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: ['.envgit'] },
    })
  })
})

describe('compileSrt and the gate', () => {
  it('terminates TLS and filters requests only when there are request rules and a gate', () => {
    const withNet = { irreversible: [{ net: { host: 'github.com', method: 'POST' } }] }
    const gate = new Gate(withNet)
    const c = compileSrt(withNet, gate)
    expect(c.network.tlsTerminate).toEqual({})
    expect(c.network.filterRequest).toBe(gate.filterRequest)
    expect(c.network.ambiguousRequestTarget).toBe('refuse')
    expect(compileSrt(withNet).network.tlsTerminate).toBeUndefined()
    const shellOnly = { irreversible: [{ shell: ['git push'] }] }
    expect(compileSrt(shellOnly, new Gate(shellOnly)).network.filterRequest).toBeUndefined()
    const pinned = { ...withNet, network: { noInspect: ['pinned.example.com'] } }
    expect(compileSrt(pinned, new Gate(pinned)).network.tlsTerminate).toEqual({ excludeDomains: ['pinned.example.com'] })
  })

  it('rejects an unknown irreversible action', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const f = join(await mkdtemp(join(tmpdir(), 'envgit-pol-')), 'p.yaml')
    await writeFile(f, 'irreversible:\n  - shell: ["git push"]\n    action: alow\n')
    await expect(loadPolicy(f)).rejects.toThrow(/must be ask, deny or allow/)
  })
})

describe('shellQuote', () => {
  it('quotes only when needed', () => {
    expect(shellQuote(['echo', 'hi', 'a b', "it's", '$HOME'])).toBe(`echo hi 'a b' 'it'\\''s' '$HOME'`)
  })
})

describe('the default preset', () => {
  const load = async (yaml: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'envgit-preset-'))
    await writeFile(join(dir, 'policy.yaml'), yaml)
    return loadPolicy(join(dir, 'policy.yaml'))
  }
  const req = (method: string, host: string, path: string) => ({ method, host, port: 443, path })

  it('expands in place, after the rules written before it, its action replacing ask', async () => {
    const p = await load('irreversible:\n  - net: { host: github.com, method: POST, path: /me/scratch.git/git-receive-pack }\n    action: allow\n  - preset: default\n')
    expect(p.irreversible!.length).toBe(1 + PRESETS.default!.length)
    expect(judgeNet(p, req('POST', 'github.com', '/me/scratch.git/git-receive-pack')).action).toBe('allow')
    expect(judgeNet(p, req('POST', 'github.com', '/me/other.git/git-receive-pack'))).toEqual({ action: 'ask', rule: 'git push' })
    const denying = await load('irreversible:\n  - preset: default\n    action: deny\n')
    expect(judgeNet(denying, req('PUT', 'registry.npmjs.org', '/left-pad')).action).toBe('deny')
    expect(judgeShell(denying, ['git', 'push', 'origin', 'main'])).toEqual({ action: 'deny', rule: 'shell: git push' })
    await expect(load('irreversible:\n  - preset: strict\n')).rejects.toThrow(/preset "strict" does not exist \(there is: default\)/)
  })

  it('gates publishing and pushing, not reading', async () => {
    const p = await load('irreversible:\n  - preset: default\n')
    const verdict = (m: string, h: string, path: string) => judgeNet(p, req(m, h, path))
    const gated: [string, string, string, string][] = [
      ['POST', 'gitlab.example.com', '/group/sub/app.git/git-receive-pack', 'git push'],
      ['PUT', 'registry.npmjs.org', '/@scope%2fpkg', 'npm publish/unpublish'],
      ['DELETE', 'registry.npmjs.org', '/pkg/-rev/3-abc', 'npm publish/unpublish'],
      ['POST', 'upload.pypi.org', '/legacy/', 'PyPI upload'],
      ['PUT', 'crates.io', '/api/v1/crates/new', 'cargo publish/yank'],
      ['PUT', 'ghcr.io', '/v2/acme/tools/app/manifests/1.2.0', 'container image push'],
      ['POST', 'api.github.com', '/repos/a/b/issues', 'GitHub API write'],
      ['PUT', 'api.github.com', '/repos/a/b/pulls/1/merge', 'GitHub API write'],
      ['DELETE', 'api.github.com', '/repos/a/b', 'GitHub API write'],
      ['PATCH', 'api.github.com', '/user', 'GitHub API write'],
      ['POST', 'gitlab.com', '/api/v4/projects/1/merge_requests', 'GitLab API write'],
      ['POST', '127.0.0.1:2375', '/v1.47/images/acme/app/push', 'docker push'],
      ['POST', 'docker', '/images/app/push', 'docker push'],
    ]
    for (const [m, h, path, rule] of gated) expect(verdict(m, h, path), `${m} ${h}${path}`).toEqual({ action: 'ask', rule })
    const passed: [string, string, string][] = [
      ['POST', 'github.com', '/a/b.git/git-upload-pack'], // fetch
      ['GET', 'registry.npmjs.org', '/left-pad'],
      ['GET', 'ghcr.io', '/v2/acme/app/manifests/1.2.0'], // pull
      ['POST', 'api.github.com', '/graphql'], // body not read: a body rule cannot match
      ['GET', 'api.github.com', '/repos/a/b/issues'],
      ['POST', 'api.github.com', '/markdown'],
      ['GET', 'gitlab.com', '/api/v4/projects/1'],
    ]
    for (const [m, h, path] of passed) expect(verdict(m, h, path), `${m} ${h}${path}`).toEqual({ action: 'pass' })
    for (const cmd of ['npm publish --access public', 'cargo publish', 'docker push ghcr.io/a/b', 'gh pr merge 3 --squash', 'terraform apply -auto-approve'])
      expect(judgeShell(p, cmd.split(' '))?.action, cmd).toBe('ask')
    expect(judgeShell(p, ['git', 'pull'])).toBeUndefined()
  })

  it('asks about GraphQL mutations by their body, not queries', async () => {
    const p = await load('irreversible:\n  - preset: default\n')
    const gql = (host: string, path: string, body: string) => judgeNet(p, { ...req('POST', host, path), body })
    expect(gql('api.github.com', '/graphql', '{"query":"mutation { addStar(input: {}) { clientMutationId } }"}')).toEqual({ action: 'ask', rule: 'GitHub GraphQL mutation' })
    expect(gql('api.github.com', '/graphql', '{"query":"query { viewer { login } }"}')).toEqual({ action: 'pass' })
    expect(gql('gitlab.com', '/api/graphql', '{"query":"mutation { x }"}')).toEqual({ action: 'ask', rule: 'GitLab GraphQL mutation' })
  })

  it('refuses SSH at the proxy with a reason, unless allowed', async () => {
    const p = await load('irreversible:\n  - preset: default\n')
    expect(compileSrt(p).network.deniedDomains).toEqual(['*:22'])
    expect(compileSrt(await load('irreversible:\n  - tunnel: "*:22"\n    action: allow\n  - preset: default\n')).network.deniedDomains).toEqual([])
    expect(compileSrt(await load('irreversible:\n  - preset: default\n    action: allow\n')).network.deniedDomains).toEqual([])
    await expect(load('irreversible:\n  - tunnel: "*"\n')).rejects.toThrow(/needs a :port/)
  })

  it('keeps the docker socket out unless a socket rule allows it', async () => {
    const sock = 'network:\n  allowUnixSockets: [/var/run/docker.sock]\n'
    await expect(load(`${sock}irreversible:\n  - preset: default\n`)).rejects.toThrow(/"docker daemon".*action: allow/)
    const docker = `${sock}irreversible:\n  - socket: /var/run/docker.sock\n    action: allow\n  - preset: default\n`
    const all = `${sock}irreversible:\n  - socket: "**"\n    action: allow\n  - preset: default\n`
    if (process.platform === 'linux') {
      // srt lets in every socket or none there, so allowing one means allowing them all.
      await expect(load(docker)).rejects.toThrow(/on Linux any allowUnixSockets entry lets in every socket/)
      expect(compileSrt(await load(all)).network.allowAllUnixSockets).toBe(true)
      return
    }
    expect(compileSrt(await load(docker)).network.allowUnixSockets).toEqual(['/var/run/docker.sock'])
    // Not a socket a rule names: let in as asked.
    expect(compileSrt(await load('network:\n  allowUnixSockets: [/tmp/app.sock]\nirreversible:\n  - preset: default\n')).network.allowUnixSockets).toEqual(['/tmp/app.sock'])
  })

  it('is what envgit init writes', async () => {
    const p = await loadPolicy(fileURLToPath(new URL('../examples/policy.yaml', import.meta.url)))
    expect(p.irreversible).toEqual(PRESETS.default)
  })
})
