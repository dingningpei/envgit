import { describe, expect, it } from 'vitest'
import { OUTPUT_LIMIT, rewrite, VmEngine } from '../src/repl/engine.js'

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

  it('cuts long output in the middle, keeping head and tail', async () => {
    const r = await new VmEngine({}).execute('for (let i = 0; i < 1000; i++) print(String(i).padStart(4, "0") + "x".repeat(195))')
    expect(r.output.length).toBeLessThan(OUTPUT_LIMIT + 200)
    expect(r.output.startsWith('0000x')).toBe(true)
    expect(r.output).toMatch(/\n…\[160000 characters of output cut here; print less, a slice, or sample\(…\)\]…\n/)
    expect(r.output.endsWith('0999' + 'x'.repeat(195) + '\n')).toBe(true)
  })

  it('keeps a large returned value in the sandbox as $n and returns its type', async () => {
    const e = new VmEngine({})
    const r = await e.execute('const issues = Array.from({ length: 200 }, (_, i) => ({ number: i, title: "issue ".repeat(5), ...(i % 2 ? { labels: ["bug"] } : {}) })); issues')
    expect(r.output).toMatch(/^\$1 = Array\(200\): \d+ characters if printed, so it stays in the sandbox\. Type: \{ number: number; title: string; labels\?: string\[\] \}\[\]\nUse \$1 in code: \$1\.length, \$1\.slice\(…\), sample\(\$1\), schema\(\$1\)\.\n$/)
    expect((await e.execute('$1.filter(i => i.labels).length')).output).toBe('100\n')
    // A string is text made to be read, often the answer: printed, not kept.
    expect((await e.execute('"y".repeat(5000)')).output).toBe('y'.repeat(5000) + '\n')
    expect((await e.execute('Object.fromEntries(Array.from({ length: 500 }, (_, i) => ["k" + i, i]))')).output).toMatch(/^\$2 = object: \d+ characters[^\n]*Type: \{ k0: number; [^\n]*\/\* 470 more keys \*\/ \}\nUse \$2 in code: Object\.keys\(\$2\)/)
    expect((await e.execute('[1, 2]')).output).toBe('[ 1, 2 ]\n')
  })

  it('returns everything in raw mode', async () => {
    const r = await new VmEngine({}).execute('"z".repeat(50000)', { raw: true })
    expect(r.output).toBe('z'.repeat(50000) + '\n')
  })

  it('injects sample, schema and assert', async () => {
    const e = new VmEngine({})
    expect((await e.execute('sample([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)')).output).toBe('[ 0, 4, 8 ]\n')
    expect((await e.execute('sample({ a: 1, b: 2, c: 3 }, 2)')).output).toBe('{ a: 1, b: 2 }\n')
    expect((await e.execute('schema([{ a: 1, b: { c: "x" } }, { a: null, d: [1, "s"] }, 3])')).output).toBe(
      '({ a: number | null; b?: { c: string }; d?: (number | string)[] } | number)[]\n',
    )
    expect(await e.execute('assert([1].length === 1); assert(false, "no rows")')).toEqual({ output: '', error: 'AssertionError: no rows' })
  })
})
