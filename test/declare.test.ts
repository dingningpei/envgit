import { describe, expect, it } from 'vitest'
import { declareServer } from '../src/core/mcp/declare.js'

describe('declareServer', () => {
  it('prints arguments, optionality, enums, arrays, unions and $refs as TypeScript', () => {
    const d = declareServer('gh', [
      {
        name: 'search',
        description: 'Search */ things.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'query' },
            labels: { type: 'array', items: { type: 'string' } },
            filters: { type: 'array', items: { type: 'object', properties: { f: { type: 'string' } } } },
            near: { anyOf: [{ type: 'object', properties: { lat: { type: 'number' } } }, { type: 'null' }] },
            tree: { $ref: '#/$defs/Tree' },
            sort: { enum: ['asc', 'desc'] },
            since: { type: ['string', 'null'] },
            page: { $ref: '#/$defs/Page' },
            'per-page': { type: 'integer' },
            meta: { type: 'object', additionalProperties: { type: 'number' } },
          },
          required: ['q'],
          $defs: { Page: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, Tree: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Tree' } } } } },
        },
        outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
      },
      { name: 'ping', inputSchema: { type: 'object' } },
      { name: 'list-all', inputSchema: { type: 'object', properties: { kinds: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } } },
    ])
    expect(d).toBe(`declare const gh: {
  /** Search * / things. */
  search(args: {
    /** query */
    q: string
    labels?: string[]
    filters?: {
      f?: string
    }[]
    near?: {
      lat?: number
    } | null
    tree?: {
      kids?: {
        kids?: {
          kids?: {
            kids?: {
              kids?: unknown
            }[]
          }[]
        }[]
      }[]
    }
    sort?: "asc" | "desc"
    since?: string | null
    page?: {
      n: number
    }
    "per-page"?: number
    meta?: { [key: string]: number }
  }): Promise<{
    total?: number
  }>
  ping(args?: { [key: string]: unknown }): Promise<unknown>
  "list-all"(args?: {
    kinds?: (string | number)[]
  }): Promise<unknown>
}`)
  })
})
