/** REPL engine. See docs/design.md §3.3 */
import { inspect, types } from 'node:util'
import vm from 'node:vm'
import { parse, type Node, type Pattern, type Program } from 'acorn'

export interface ExecuteResult {
  output: string
  error?: string
}

export interface Engine {
  execute(code: string): Promise<ExecuteResult>
}

const MAX_OUTPUT = 64 * 1024

// node:vm is not a security boundary; the worker runs under srt, which is.
export class VmEngine implements Engine {
  private readonly context: vm.Context
  private out: string[] = []
  private size = 0

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
    })
  }

  async execute(code: string): Promise<ExecuteResult> {
    this.out = []
    this.size = 0
    try {
      const { hoisted, body } = rewrite(code)
      if (hoisted.length) vm.runInContext(`var ${hoisted.join(', ')};`, this.context)
      const value = await vm.runInContext(`(async () => {\n${body}\n})()`, this.context, { filename: 'repl' })
      if (value !== undefined) this.print([value])
      return { output: this.out.join('') }
    } catch (e) {
      return { output: this.out.join(''), error: types.isNativeError(e) ? `${e.name}: ${e.message}` : inspect(e) }
    }
  }

  private print(args: unknown[]) {
    if (this.size >= MAX_OUTPUT) return
    const line = args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ') + '\n'
    this.out.push(line.slice(0, MAX_OUTPUT - this.size))
    this.size += line.length
    if (this.size >= MAX_OUTPUT) this.out.push('…[output truncated]\n')
  }
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
