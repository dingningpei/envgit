import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { compileSrt, matchIrreversible } from '../src/core/policy/compile.js'
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
        denyWrite: ['.env'],
      },
    })
  })

  it('defaults to no network and no writes', () => {
    expect(compileSrt({})).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    })
  })
})

describe('matchIrreversible', () => {
  const policy = { irreversible: [{ shell: ['git push', 'npm publish'] }] }
  it('matches on word boundaries', () => {
    expect(matchIrreversible(policy, ['git', 'push', 'origin'])).toBe('shell: git push')
    expect(matchIrreversible(policy, ['npm', 'publish'])).toBe('shell: npm publish')
    expect(matchIrreversible(policy, ['git', 'pushx'])).toBeUndefined()
    expect(matchIrreversible(policy, ['git', 'status'])).toBeUndefined()
  })
})

describe('shellQuote', () => {
  it('quotes only when needed', () => {
    expect(shellQuote(['echo', 'hi', 'a b', "it's", '$HOME'])).toBe(`echo hi 'a b' 'it'\\''s' '$HOME'`)
  })
})
