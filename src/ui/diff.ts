/** Unified line diffs for the timeline (small files only; callers cap sizes). */

export interface Hunk {
  header: string
  lines: string[]
}

/** Lines each side beyond which no line diff is computed (the LCS table is n·m). */
const MAX_LINES = 3000
const CONTEXT = 3

/** Hunks of `a` → `b`, or undefined when the files are too long to diff line by line. */
export function unifiedDiff(a: string, b: string): Hunk[] | undefined {
  const x = splitLines(a)
  const y = splitLines(b)
  if (x.length > MAX_LINES || y.length > MAX_LINES) return undefined
  // Trim the common prefix and suffix first: most edits are small.
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const xs = x.slice(pre, x.length - suf)
  const ys = y.slice(pre, y.length - suf)
  const n = xs.length
  const m = ys.length
  const lcs = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] = xs[i] === ys[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
  // Every line of both files tagged ' ', '-' or '+', with its line numbers.
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = []
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', s: x[k]!, ai: k, bi: k })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) (ops.push({ t: ' ', s: xs[i]!, ai: pre + i, bi: pre + j }), i++, j++)
    // Deletions before additions, as diff(1) prints them.
    else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) (ops.push({ t: '-', s: xs[i]!, ai: pre + i, bi: pre + j }), i++)
    else (ops.push({ t: '+', s: ys[j]!, ai: pre + i, bi: pre + j }), j++)
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', s: x[x.length - suf + k]!, ai: x.length - suf + k, bi: y.length - suf + k })

  const hunks: Hunk[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++
      continue
    }
    const start = Math.max(0, k - CONTEXT)
    let end = k
    // Extend over changes separated by at most 2·CONTEXT unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== ' ') end++
      let gap = end
      while (gap < ops.length && ops[gap]!.t === ' ' && gap - end < 2 * CONTEXT) gap++
      if (gap < ops.length && ops[gap]!.t !== ' ') end = gap
      else break
    }
    end = Math.min(ops.length, end + CONTEXT)
    const slice = ops.slice(start, end)
    const aStart = slice[0]!.ai
    const bStart = slice[0]!.bi
    const aLen = slice.filter(o => o.t !== '+').length
    const bLen = slice.filter(o => o.t !== '-').length
    // An empty side is numbered as the line before it (`-0,0` for a new file).
    hunks.push({ header: `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`, lines: slice.map(o => o.t + o.s) })
    k = end
  }
  return hunks
}

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
