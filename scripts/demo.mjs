#!/usr/bin/env node
// M1 demo: the same task through one MCP tool per capability vs. envgit's `execute`.
// Runs `claude -p` on the caller's Claude Code login. See docs/demo-m1.md.
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'dist/cli/index.js')
const OUT = join(ROOT, 'demo/results')
const MODEL = process.env.DEMO_MODEL ?? 'claude-opus-5-5'
const REPEATS = Number(process.env.DEMO_REPEATS ?? 3)
const ARMS = (process.env.DEMO_ARMS ?? 'tools,execute').split(',')
const CORPORA = {
  // envgit's own sources: 12 files, ~48 KB
  src: { from: join(ROOT, 'src'), dir: 'src', ext: '.ts' },
  // sandbox-runtime's type declarations: 38 files, ~380 KB
  'srt-dts': { from: join(ROOT, 'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox'), dir: 'types', ext: '.d.ts' },
}
const CORPUS_NAME = process.env.DEMO_CORPUS ?? 'src'
const CORPUS = CORPORA[CORPUS_NAME]
if (!CORPUS) throw new Error(`unknown DEMO_CORPUS ${CORPUS_NAME}`)

const TASK = `Using only the envgit tools, inspect every ${CORPUS.ext} file under ${CORPUS.dir}/ (recursively).
For each file report the builtin modules it imports through a "node:" specifier (ignore
imports without that prefix) and the names it exports
(top-level \`export function|async function|class|const|let|interface|type\` declarations).
Reply with ONLY a JSON array, no prose, of objects
{"file": "<path relative to the project root>", "builtins": [...], "exports": [...]}
sorted by file; builtins without the "node:" prefix ("node:fs/promises" → "fs/promises"),
both arrays sorted alphabetically.`

const POLICY = `filesystem:
  read: { deny: ["~/.ssh", "~/.aws"] }
  write: { allow: ["."] }
capabilities:
  fs: true
`

// Directories and files with the corpus extension only (no .js, .map, …).
function copyCorpus(dir) {
  return cp(CORPUS.from, join(dir, CORPUS.dir), {
    recursive: true,
    filter: src => !/\.[^/]*$/.test(src.slice(CORPUS.from.length)) || src.endsWith(CORPUS.ext),
  })
}

async function walk(dir) {
  const out = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) out.push(...(await walk(p)))
    else if (d.name.endsWith(CORPUS.ext)) out.push(p)
  }
  return out
}

async function groundTruth(dir) {
  const rows = []
  for (const f of await walk(join(dir, CORPUS.dir))) {
    const src = await readFile(f, 'utf8')
    const builtins = [...src.matchAll(/from\s+'node:([\w/]+)'/g)].map(m => m[1])
    const exports = [...src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|interface|type)\s+(\w+)/gm)].map(m => m[1])
    rows.push({ file: relative(dir, f), builtins: [...new Set(builtins)].sort(), exports: [...new Set(exports)].sort() })
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file))
}

function parseAnswer(text) {
  const m = text?.match(/\[[\s\S]*\]/)
  try {
    return m ? JSON.parse(m[0]) : undefined
  } catch {
    return undefined
  }
}

const norm = rows =>
  JSON.stringify(
    (rows ?? [])
      .map(r => ({ file: r.file, builtins: [...(r.builtins ?? [])].sort(), exports: [...(r.exports ?? [])].sort() }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  )

function claude(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT$|BAGGAGE$)/.test(k)))
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))))
  })
}

function summarize(jsonl) {
  const events = jsonl.trim().split('\n').map(l => JSON.parse(l))
  const messages = new Map()
  let toolCalls = 0
  let toolResultChars = 0
  for (const e of events) {
    if (e.type === 'assistant') {
      messages.set(e.message.id, e.message.usage)
      toolCalls += e.message.content.filter(c => c.type === 'tool_use').length
    } else if (e.type === 'user') {
      for (const c of e.message.content ?? []) {
        if (c.type === 'tool_result') toolResultChars += JSON.stringify(c.content).length
      }
    }
  }
  const usages = [...messages.values()]
  const context = u => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  const result = events.find(e => e.type === 'result')
  return {
    requests: usages.length,
    toolCalls,
    toolResultChars,
    firstRequestContext: usages.length ? context(usages[0]) : 0,
    contextTokens: usages.reduce((s, u) => s + context(u), 0),
    // Per-event usage is the message_start snapshot; only the result carries final output counts.
    outputTokens: result?.usage?.output_tokens,
    costUsd: result?.total_cost_usd,
    answer: result?.result,
  }
}

async function runOnce(arm, i, truth) {
  const dir = await mkdtemp(join(tmpdir(), `envgit-demo-${CORPUS_NAME}-${arm}-`))
  await copyCorpus(dir)
  await mkdir(join(dir, '.envgit/sessions'), { recursive: true })
  await writeFile(join(dir, '.envgit/policy.yaml'), POLICY)
  const mcpConfig = join(dir, 'mcp.json')
  const serverArgs = [CLI, 'mcp', ...(arm === 'tools' ? ['--tools'] : [])]
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { envgit: { command: process.execPath, args: serverArgs } } }))
  const jsonl = await claude(
    ['-p', TASK, '--model', MODEL, '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__envgit__*',
     '--setting-sources', '', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
    dir,
  )
  await writeFile(join(OUT, `${CORPUS_NAME}-${arm}-${i}.jsonl`), jsonl)
  const s = summarize(jsonl)
  return { corpus: CORPUS_NAME, arm, run: i, ...s, correct: norm(parseAnswer(s.answer)) === norm(truth) }
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

await mkdir(OUT, { recursive: true })
const truthDir = await mkdtemp(join(tmpdir(), 'envgit-demo-truth-'))
await copyCorpus(truthDir)
const truth = await groundTruth(truthDir)
await writeFile(join(OUT, `${CORPUS_NAME}-ground-truth.json`), JSON.stringify(truth, null, 2) + '\n')
const runs = []
for (let i = 1; i <= REPEATS; i++) {
  for (const arm of ARMS) {
    const r = await runOnce(arm, i, truth)
    const { answer, ...row } = r
    console.error(JSON.stringify(row))
    runs.push(r)
  }
}
await writeFile(join(OUT, `${CORPUS_NAME}-${ARMS.join('+')}-runs.json`), JSON.stringify(runs.map(({ answer, ...r }) => r), null, 2) + '\n')

const keys = ['requests', 'toolCalls', 'toolResultChars', 'firstRequestContext', 'contextTokens', 'outputTokens', 'costUsd']
const table = ARMS.map(arm => {
  const rs = runs.filter(r => r.arm === arm)
  return { corpus: CORPUS_NAME, arm, correct: `${rs.filter(r => r.correct).length}/${rs.length}`, ...Object.fromEntries(keys.map(k => [k, median(rs.map(r => r[k]))])) }
})
console.log(JSON.stringify(table, null, 2))
await writeFile(join(OUT, `${CORPUS_NAME}-${ARMS.join('+')}-summary.json`), JSON.stringify(table, null, 2) + '\n')
