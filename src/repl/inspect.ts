/**
 * Looking at data without reading all of it (docs/design.md §3.3): `sample`, `schema` and `assert` are
 * injected into the REPL, and a large returned value is summarized with `schema` instead of printed.
 * Dependency-free: it ships in the vm worker bundle.
 */
const MAX_DEPTH = 4
const MAX_KEYS = 30

/** n items spread across an array, first and last included; n entries of an object. */
export function sample<T>(x: T[] | Record<string, T>, n = 3): T[] | Record<string, T> {
  if (Array.isArray(x)) {
    if (x.length <= n) return [...x]
    if (n <= 1) return x.slice(0, Math.max(n, 0))
    return Array.from({ length: n }, (_, i) => x[Math.round((i * (x.length - 1)) / (n - 1))]!)
  }
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).slice(0, n))
  throw new TypeError('sample: expected an array or an object')
}

export class AssertionError extends Error {
  override name = 'AssertionError'
}

export function assert(cond: unknown, message = 'assertion failed'): asserts cond {
  if (!cond) throw new AssertionError(message)
}

/** The shape of a value as a TypeScript type; array elements are merged, keys missing in some are optional. */
export function schema(x: unknown): string {
  return render(shapeOf(x, 0), 0)
}

/** One line for a returned array or object kept in the sandbox as `name`. */
export function summarize(name: string, x: unknown, chars: number): string {
  const what = Array.isArray(x) ? `Array(${x.length})` : 'object'
  const type = schema(x)
  const look = Array.isArray(x) ? `${name}.length, ${name}.slice(…)` : `Object.keys(${name})`
  return `${name} = ${what}: ${chars} characters if printed, so it stays in the sandbox. Type: ${type}\nUse ${name} in code: ${look}, sample(${name}), schema(${name}).`
}

type Shape =
  | { kind: 'prim'; names: Set<string> }
  | { kind: 'array'; item: Shape | undefined }
  | { kind: 'object'; keys: Map<string, { shape: Shape; count: number }>; count: number }
  | { kind: 'union'; parts: Shape[] }
  | { kind: 'deep' }

function shapeOf(x: unknown, depth: number): Shape {
  if (x === null) return prim('null')
  if (Array.isArray(x)) {
    if (depth >= MAX_DEPTH) return { kind: 'deep' }
    return { kind: 'array', item: x.reduce<Shape | undefined>((s, v) => merge(s, shapeOf(v, depth + 1)), undefined) }
  }
  if (typeof x === 'object') {
    if (depth >= MAX_DEPTH) return { kind: 'deep' }
    const keys = new Map<string, { shape: Shape; count: number }>()
    for (const [k, v] of Object.entries(x as object)) keys.set(k, { shape: shapeOf(v, depth + 1), count: 1 })
    return { kind: 'object', keys, count: 1 }
  }
  return prim(typeof x === 'undefined' ? 'undefined' : typeof x)
}

const prim = (name: string): Shape => ({ kind: 'prim', names: new Set([name]) })

function merge(a: Shape | undefined, b: Shape): Shape {
  if (!a) return b
  if (a.kind === 'prim' && b.kind === 'prim') return { kind: 'prim', names: new Set([...a.names, ...b.names]) }
  if (a.kind === 'array' && b.kind === 'array') return { kind: 'array', item: b.item ? merge(a.item, b.item) : a.item }
  if (a.kind === 'object' && b.kind === 'object') {
    const keys = new Map(a.keys)
    for (const [k, v] of b.keys) {
      const prev = keys.get(k)
      keys.set(k, prev ? { shape: merge(prev.shape, v.shape), count: prev.count + v.count } : v)
    }
    return { kind: 'object', keys, count: a.count + b.count }
  }
  if (a.kind === 'deep' && b.kind === 'deep') return a
  // Different kinds: a union, merging into the part of the same kind.
  const parts = a.kind === 'union' ? [...a.parts] : [a]
  for (const p of b.kind === 'union' ? b.parts : [b]) {
    const i = parts.findIndex(q => q.kind === p.kind)
    if (i >= 0) parts[i] = merge(parts[i], p)
    else parts.push(p)
  }
  return { kind: 'union', parts }
}

function render(s: Shape | undefined, depth: number): string {
  if (!s) return 'never'
  switch (s.kind) {
    case 'prim':
      return [...s.names].join(' | ')
    case 'deep':
      return 'unknown'
    case 'union':
      return s.parts.map(p => render(p, depth)).join(' | ')
    case 'array': {
      const item = render(s.item, depth)
      const union = s.item?.kind === 'union' || (s.item?.kind === 'prim' && s.item.names.size > 1)
      return `${union ? `(${item})` : item}[]`
    }
    case 'object': {
      const entries = [...s.keys]
      if (!entries.length) return '{}'
      const shown = entries.slice(0, MAX_KEYS).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${v.count < s.count ? '?' : ''}: ${render(v.shape, depth + 1)}`)
      if (entries.length > MAX_KEYS) shown.push(`/* ${entries.length - MAX_KEYS} more keys */`)
      return `{ ${shown.join('; ')} }`
    }
  }
}
