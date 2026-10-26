import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { compileSrt } from '../src/core/policy/compile.js'
import { Gate } from '../src/core/policy/gate.js'
import { loadPolicy } from '../src/core/policy/load.js'
import { shellQuote } from '../src/core/env/srt.js'

describe('compileSrt', () => {
  it('maps the example policy onto srt settings', async () => {
    const policy = await loadPolicy(fileURLToPath(new URL('../examples/policy.yaml', import.meta.url)))
    expect(compileSrt(policy)).toEqual({
      network: { allowedDomains: ['api.github.com:443', 'registry.npmjs.org'], deniedDomains: [] },
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
