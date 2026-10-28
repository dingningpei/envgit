/** What changed between two snapshots, as unified line diffs: the timeline's diffs and `envgit show` / `diff`. */
import type { SnapshotId } from '../core/env/backend.js'
import type { SessionMeta, Step, StepRef } from '../core/snapshot/log.js'
import type { Entry } from '../core/snapshot/store.js'
import { SnapshotStore } from '../core/snapshot/store.js'

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

const MAX_DIFF_FILES = 200
const MAX_DIFF_BYTES = 1 << 20

export type FileChange = { path: string; status: 'added' | 'deleted' | 'modified'; kind: string; hunks?: Hunk[]; note?: string }
export interface SnapshotDiff {
  files: FileChange[]
  /** Changed files past MAX_DIFF_FILES, not shown. */
  more: number
  dirs: string[]
  /** `before` was not given or is gone, so everything in `after` shows as added. */
  baseMissing: boolean
}
export type DiffResult = SnapshotDiff | { error: string } | { unavailable: string }

/** What a step changed in the workdir: its snapshot against its parent's (fs-level snapshots, srt only). */
export async function stepDiff(root: string, meta: SessionMeta, steps: Step[], pruned: Set<StepRef>, index: number): Promise<DiffResult> {
  if (meta.backend === 'vm') return { unavailable: 'vm snapshots are memory and disk images; the step’s file effects (from the mirror sync) list what changed in /work' }
  const step = steps[index]
  if (!step?.snapshot) return { error: 'no such step, or it has no snapshot' }
  if (pruned.has(index)) return { unavailable: 'this step’s snapshot was dropped to stay under snapshot.maxBytes; its file effects above still list what it changed' }
  const parentRef = step.parent ?? 'base'
  const parentId = pruned.has(parentRef) ? undefined : step.parent === undefined ? meta.base : steps[step.parent]?.snapshot
  const d = await diffSnapshots(new SnapshotStore(root), parentId, step.snapshot)
  return d ?? { error: 'the step’s snapshot is gone (envgit gc?)' }
}

/** `before` → `after`; undefined when `after` is not in the store. A missing `before` diffs against nothing. */
export async function diffSnapshots(store: SnapshotStore, beforeId: SnapshotId | undefined, afterId: SnapshotId): Promise<SnapshotDiff | undefined> {
  const read = async (id: SnapshotId | undefined) => (id && (await store.has(id)) ? new Map((await store.read(id)).entries.map(e => [e.path, e])) : undefined)
  const [before, after] = [await read(beforeId), await read(afterId)]
  if (!after) return undefined
  const prev = before ?? new Map<string, Entry>()
  const changes: FileChange[] = []
  const same = (a: Entry, b: Entry) =>
    a.kind === b.kind && (a.kind === 'file' ? a.hash === (b as typeof a).hash && a.mode === (b as typeof a).mode : a.kind === 'symlink' ? a.target === (b as typeof a).target : true)
  for (const [path, e] of after) {
    const p = prev.get(path)
    if (!p) changes.push({ path, status: 'added', kind: e.kind })
    else if (!same(p, e)) changes.push({ path, status: 'modified', kind: e.kind })
  }
  for (const [path, e] of prev) if (!after.has(path)) changes.push({ path, status: 'deleted', kind: e.kind })
  changes.sort((a, b) => a.path.localeCompare(b.path))
  const shown = changes.filter(c => c.kind !== 'dir').slice(0, MAX_DIFF_FILES)
  for (const c of shown) {
    const a = prev.get(c.path)
    const b = after.get(c.path)
    if ((a && a.kind !== 'file') || (b && b.kind !== 'file')) {
      c.note = [a, b].map(e => (e?.kind === 'symlink' ? `symlink → ${e.target}` : e?.kind)).filter(Boolean).join(' → ')
      continue
    }
    const sizes = [a, b].map(e => (e?.kind === 'file' ? e.size : 0))
    if (Math.max(...sizes) > MAX_DIFF_BYTES) {
      c.note = `too large to show (${sizes.map(n => `${(n / 1e6).toFixed(1)} MB`).join(' → ')})`
      continue
    }
    const text = async (e?: Entry) => (e?.kind === 'file' ? await store.readBlob(e.hash).catch(() => undefined) : Buffer.alloc(0))
    const [ta, tb] = [await text(a), await text(b)]
    if (!ta || !tb) c.note = 'contents no longer stored'
    else if (ta.subarray(0, 8192).includes(0) || tb.subarray(0, 8192).includes(0)) c.note = 'binary'
    else {
      const hunks = unifiedDiff(ta.toString('utf8'), tb.toString('utf8'))
      if (hunks) c.hunks = hunks
      else c.note = 'too many lines to diff'
    }
    if (c.status === 'modified' && a?.kind === 'file' && b?.kind === 'file' && a.hash === b.hash) c.note = `mode ${a.mode.toString(8)} → ${b.mode.toString(8)}`
  }
  return { files: shown, more: changes.filter(c => c.kind !== 'dir').length - shown.length, dirs: changes.filter(c => c.kind === 'dir').map(c => `${c.status} ${c.path}/`), baseMissing: !before }
}

/**
 * A SnapshotDiff as text: `--- a/` / `+++ b/` headers and hunks, as diff -u prints them, so `patch -p1`
 * applies the text files; a file without hunks (binary, too large, a symlink, a mode) gets one line saying why.
 */
export function formatDiff(d: SnapshotDiff, color = false): string {
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const out: string[] = []
  for (const f of d.files) {
    out.push(paint(1, `diff a/${f.path} b/${f.path}`))
    if (f.note || !f.hunks) {
      out.push(`${f.status} ${f.kind}: ${f.note ?? 'no changes to show'}`)
      continue
    }
    if (f.status !== 'modified') out.push(`${f.status === 'added' ? 'new' : 'deleted'} file`)
    out.push(paint(1, `--- ${f.status === 'added' ? '/dev/null' : `a/${f.path}`}`), paint(1, `+++ ${f.status === 'deleted' ? '/dev/null' : `b/${f.path}`}`))
    for (const h of f.hunks) {
      out.push(paint(36, h.header))
      for (const l of h.lines) out.push(l[0] === '+' ? paint(32, l) : l[0] === '-' ? paint(31, l) : l)
    }
  }
  for (const dir of d.dirs) out.push(dir)
  if (d.more) out.push(`… and ${d.more} more file(s), not shown`)
  return out.length ? out.join('\n') + '\n' : ''
}
