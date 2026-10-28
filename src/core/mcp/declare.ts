/** TypeScript declarations for MCP tools, from their JSON Schema, shown to the model in `execute`. */
import type { McpTool } from './client.js'

type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  const?: unknown
  anyOf?: Schema[]
  oneOf?: Schema[]
  allOf?: Schema[]
  additionalProperties?: boolean | Schema
  description?: string
  $ref?: string
}

const MAX_DEPTH = 6
const MAX_DESCRIPTION = 500
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

export function declareServer(name: string, tools: McpTool[]): string {
  const members = tools.map(t => {
    const input = (t.inputSchema ?? {}) as Schema
    const args = tsType(input, input, 1)
    const optional = !(input.required?.length) ? '?' : ''
    const out = t.outputSchema ? tsType(t.outputSchema as Schema, t.outputSchema as Schema, 1) : 'unknown'
    return `${doc(t.description, '  ')}  ${key(t.name)}(args${optional}: ${args}): Promise<${out}>`
  })
  return `declare const ${name}: {\n${members.join('\n')}\n}`
}

/** A tool's name as an object key: bare when it is an identifier, quoted otherwise. */
export function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** `depth` is the nesting (and indentation) level; `hops` counts $refs followed, so a cycle ends. */
function tsType(s: Schema | undefined, root: Schema, depth: number, hops = 0): string {
  if (!s || typeof s !== 'object' || depth > MAX_DEPTH || hops > MAX_DEPTH) return 'unknown'
  if (s.$ref) return tsType(resolve(s.$ref, root), root, depth, hops + 1)
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join(' | ') || 'never'
  const alts = s.anyOf ?? s.oneOf
  if (Array.isArray(alts)) return union(alts.map(a => tsType(a, root, depth, hops + 1)))
  if (Array.isArray(s.allOf)) return s.allOf.map(a => wrap(tsType(a, root, depth, hops + 1))).join(' & ')
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ['object'] : s.items ? ['array'] : []
  if (!types.length) return 'unknown'
  return union(types.map(t => one(t, s, root, depth, hops)))
}

function one(type: string, s: Schema, root: Schema, depth: number, hops: number): string {
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `${wrap(tsType(s.items, root, depth, hops + 1))}[]`
    case 'object':
      return object(s, root, depth)
    default:
      return 'unknown'
  }
}

function object(s: Schema, root: Schema, depth: number): string {
  const props = Object.entries(s.properties ?? {})
  const extra = s.additionalProperties
  const index = extra && typeof extra === 'object' ? `[key: string]: ${tsType(extra, root, depth + 1)}` : extra === true || (!props.length && extra !== false) ? '[key: string]: unknown' : ''
  if (!props.length) return index ? `{ ${index} }` : '{}'
  const pad = '  '.repeat(depth + 1)
  const required = new Set(s.required ?? [])
  const lines = props.map(([k, p]) => `${doc(p.description, pad)}${pad}${key(k)}${required.has(k) ? '' : '?'}: ${tsType(p, root, depth + 1)}`)
  if (index) lines.push(`${pad}${index}`)
  return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`
}

function resolve(ref: string, root: Schema): Schema | undefined {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  return m ? ((root as Record<string, Record<string, Schema>>)[m[1]!]?.[m[2]!]) : undefined
}

function union(parts: string[]): string {
  return [...new Set(parts)].join(' | ') || 'unknown'
}

function wrap(t: string): string {
  return /[|&]/.test(t) ? `(${t})` : t
}

function doc(text: string | undefined, pad: string): string {
  if (!text) return ''
  let line = text.replace(/\s+/g, ' ').trim().replace(/\*\//g, '* /')
  if (line.length > MAX_DESCRIPTION) line = `${line.slice(0, MAX_DESCRIPTION)}…`
  return `${pad}/** ${line} */\n`
}
