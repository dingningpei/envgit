/** REPL engine. See docs/design.md §3.3 */
import { inspect, types } from 'node:util'
import vm from 'node:vm'
import { parse, type Node, type Pattern, type Program } from 'acorn'
import { AssertionError, assert, sample, schema, summarize } from './inspect.js'

export interface ExecuteResult {
  output: string
  error?: string
}

export interface Engine {
  execute(code: string, opts?: { raw?: boolean }): Promise<ExecuteResult>
}

/**
 * A returned array or object whose printout is longer than this stays in the context as `$1`, `$2`, …
 * and comes back as its type: a page of 150 trimmed GitHub issues prints ~18k characters. A string is
 * text the code made to be read (often the answer itself), so it is printed.
 */
export const HANDLE_LIMIT = 4000
/**
 * Printed output beyond this is cut in the middle, under the ~65k characters at which Claude Code
 * replaces a tool result with a file the model cannot read, and above a ~20k-character answer the demo's
 * large corpus prints (docs/demo-m1.md).
 */
export const OUTPUT_LIMIT = 40_000
const TAIL = 5000
/** Raw cells (`envgit mcp --tools`, a tool result as the server gave it) keep only this cap. */
const RAW_LIMIT = 1 << 20

// node:vm is not a security boundary; the worker runs under srt, which is.
export class VmEngine implements Engine {
  private readonly context: vm.Context
  private head = ''
  private tail = ''
  private size = 0
  private limit = OUTPUT_LIMIT
  private handles = 0

  constructor(globals: Record<string, unknown>) {
    const print = (...args: unknown[]) => this.print(args)
    this.context = vm.createContext({
      ...globals,
      print,
      console: { log: print, info: print, warn: print, error: print },
      setTimeout,
      clearTimeout,
      URL,
      TextEncoder,
      TextDecoder,
      sample,
      schema,
      assert,
      AssertionError,
    })
  }

  async execute(code: string, opts: { raw?: boolean } = {}): Promise<ExecuteResult> {
    this.head = this.tail = ''
    this.size = 0
    this.limit = opts.raw ? RAW_LIMIT : OUTPUT_LIMIT
    try {
      const { hoisted, body } = rewrite(code)
      if (hoisted.length) vm.runInContext(`var ${hoisted.join(', ')};`, this.context)
      const value = await vm.runInContext(`(async () => {\n${body}\n})()`, this.context, { filename: 'repl' })
      if (value !== undefined) this.result(value, opts.raw)
      return { output: this.output() }
    } catch (e) {
      return { output: this.output(), error: types.isNativeError(e) ? `${e.name}: ${e.message}` : inspect(e) }
    }
  }

  private result(value: unknown, raw?: boolean) {
    const text = show(value)
    if (raw || typeof value !== 'object' || value === null || text.length <= HANDLE_LIMIT) return this.write(text + '\n')
    const name = `$${++this.handles}`
    this.context[name] = value
    this.write(summarize(name, value, text.length) + '\n')
  }

  private print(args: unknown[]) {
    this.write(args.map(show).join(' ') + '\n')
  }

  /** Keeps the first `limit - TAIL` and the last `TAIL` characters. */
  private write(s: string) {
    this.size += s.length
    const room = this.limit - TAIL - this.head.length
    if (room > 0) {
      this.head += s.slice(0, room)
      s = s.slice(room)
    }
    if (s) this.tail = (this.tail + s).slice(-TAIL)
  }

  private output(): string {
    const dropped = this.size - this.head.length - this.tail.length
    if (dropped <= 0) return this.head + this.tail
    return `${this.head}\n…[${dropped} characters of output cut here; print less, a slice, or sample(…)]…\n${this.tail}`
  }
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : inspect(v, { depth: 4 })
}

/**
 * Runs each cell as an async function so top-level await works, while keeping
 * top-level declarations alive across cells by turning them into assignments
 * to hoisted context globals. The last expression statement is returned.
 */
export function rewrite(code: string): { hoisted: string[]; body: string } {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as Program
  const hoisted = new Set<string>()
  const edits: { start: number; end: number; text: string }[] = []
  const src = (n: Node) => code.slice(n.start, n.end)

  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') {
      const parts = stmt.declarations.map(d => {
        names(d.id).forEach(n => hoisted.add(n))
        return d.init ? `(${src(d.id)} = ${src(d.init)})` : `(${src(d.id)} = undefined)`
      })
      edits.push({ start: stmt.start, end: stmt.end, text: `void (${parts.join(', ')});` })
    } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
      hoisted.add(stmt.id.name)
      edits.push({ start: stmt.start, end: stmt.end, text: `${stmt.id.name} = ${src(stmt)};` })
    }
  }
  const last = ast.body.at(-1)
  if (last?.type === 'ExpressionStatement') {
    edits.push({ start: last.start, end: last.end, text: `return (${src(last.expression)});` })
  }

  let body = code
  for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start) + e.text + body.slice(e.end)
  return { hoisted: [...hoisted], body }
}

function names(p: Pattern): string[] {
  switch (p.type) {
    case 'Identifier':
      return [p.name]
    case 'ObjectPattern':
      return p.properties.flatMap(q => names(q.type === 'RestElement' ? q.argument : q.value))
    case 'ArrayPattern':
      return p.elements.flatMap(e => (e ? names(e) : []))
    case 'RestElement':
      return names(p.argument)
    case 'AssignmentPattern':
      return names(p.left)
    default:
      return []
  }
}
