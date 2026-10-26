import { describe, expect, it } from 'vitest'
import { rewrite, VmEngine } from '../src/repl/engine.js'

describe('rewrite', () => {
  it('hoists top-level declarations and returns the last expression', () => {
    const { hoisted, body } = rewrite('const { a, b: [c] } = o; let d\nfunction f() {}\nclass K {}\nf()')
    expect(hoisted.sort()).toEqual(['K', 'a', 'c', 'd', 'f'])
    expect(body).toContain('return (f());')
    expect(body).not.toMatch(/\b(const|let)\b/)
  })
})

describe('VmEngine', () => {
  it('persists state across cells and supports top-level await', async () => {
    const e = new VmEngine({})
    expect(await e.execute('const xs = [1, 2]; class P { v() { return 3 } }')).toEqual({ output: '' })
    expect(await e.execute('xs.push(await Promise.resolve(new P().v())); xs')).toEqual({ output: '[ 1, 2, 3 ]\n' })
    expect(await e.execute('const xs = "redeclared"; print(xs)')).toEqual({ output: 'redeclared\n' })
  })

  it('reports errors with partial output and hides host globals', async () => {
    const e = new VmEngine({})
    const r = await e.execute('print("before"); throw new TypeError("boom")')
    expect(r).toEqual({ output: 'before\n', error: 'TypeError: boom' })
    expect((await e.execute('typeof process + " " + typeof require')).output).toBe('undefined undefined\n')
  })

  it('caps output', async () => {
    const r = await new VmEngine({}).execute('for (let i = 0; i < 10000; i++) print("x".repeat(100))')
    expect(r.output.length).toBeLessThan(70 * 1024)
    expect(r.output).toMatch(/output truncated/)
  })
})
