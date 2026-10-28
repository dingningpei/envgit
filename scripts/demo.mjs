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
  // GitHub's MCP server (M5): its tools, not envgit's. Needs GITHUB_TOKEN and DEMO_GITHUB_MCP (the binary).
  github: { repo: 'modelcontextprotocol/typescript-sdk', issues: 150 },
}
const CORPUS_NAME = process.env.DEMO_CORPUS ?? 'src'
const CORPUS = CORPORA[CORPUS_NAME]
if (!CORPUS) throw new Error(`unknown DEMO_CORPUS ${CORPUS_NAME}`)
const GITHUB = CORPUS_NAME === 'github'
if (GITHUB && !(process.env.GITHUB_TOKEN && process.env.DEMO_GITHUB_MCP)) throw new Error('DEMO_CORPUS=github needs GITHUB_TOKEN and DEMO_GITHUB_MCP')

const TASK = GITHUB
  ? `Using only the envgit tools, look at the first ${CORPUS.issues} issues (not pull requests) ever opened in the
GitHub repository ${CORPUS.repo}, ordered by creation time, open or closed.
Reply with ONLY a JSON object, no prose:
{"closed": <how many of them are closed>,
 "labels": {"<label name>": <how many of them carry it>, ...} (every label carried by at least one),
 "mostCommented": [<numbers of the 5 with the most comments, most first; ties: lower number first>]}`
  : `Using only the envgit tools, inspect every ${CORPUS.ext} file under ${CORPUS.dir}/ (recursively).
For each file report the builtin modules it imports through a "node:" specifier (ignore
imports without that prefix) and the names it exports
(top-level \`export function|async function|class|const|let|interface|type\` declarations).
Reply with ONLY a JSON array, no prose, of objects
{"file": "<path relative to the project root>", "builtins": [...], "exports": [...]}
sorted by file; builtins without the "node:" prefix ("node:fs/promises" → "fs/promises"),
both arrays sorted alphabetically.`

const POLICY = GITHUB
  ? `network:
  allow: ["api.github.com"]
capabilities:
  github: [list_issues, issue_read]
mcp:
  github:
    command: ${JSON.stringify(process.env.DEMO_GITHUB_MCP ?? '')}
    args: [stdio, --read-only]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "\${GITHUB_TOKEN}" }
`
  : `filesystem:
  read: { deny: ["~/.ssh", "~/.aws"] }
  write: { allow: ["."] }
capabilities:
  fs: true
`

/** The answer from GitHub's REST API directly, outside the sandbox, at the start of the run. */
async function githubTruth() {
  const issues = []
  for (let page = 1; issues.length < CORPUS.issues; page++) {
    const r = await fetch(`https://api.github.com/repos/${CORPUS.repo}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    })
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`)
    const rows = await r.json()
    if (!rows.length) break
    issues.push(...rows.filter(i => !i.pull_request))
  }
  const first = issues.slice(0, CORPUS.issues)
  const labels = {}
  for (const i of first) for (const l of i.labels) labels[l.name] = (labels[l.name] ?? 0) + 1
  const mostCommented = [...first].sort((a, b) => b.comments - a.comments || a.number - b.number).slice(0, 5).map(i => i.number)
  return { closed: first.filter(i => i.state === 'closed').length, labels, mostCommented }
}

function parseObject(text) {
  const m = text?.match(/\{[\s\S]*\}/)
  try {
    return m ? JSON.parse(m[0]) : undefined
  } catch {
    return undefined
  }
}

const sortKeys = o => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)))
const githubNorm = a => JSON.stringify(a && { closed: a.closed, labels: sortKeys(a.labels), mostCommented: a.mostCommented })

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
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || !/^(CLAUDE|AI_AGENT$|BAGGAGE$)/.test(k)))
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}${out.slice(-1500)}`))))
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
  if (!GITHUB) await copyCorpus(dir)
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
  return { corpus: CORPUS_NAME, arm, run: i, ...s, correct: GITHUB ? githubNorm(parseObject(s.answer)) === githubNorm(truth) : norm(parseAnswer(s.answer)) === norm(truth) }
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

await mkdir(OUT, { recursive: true })
let truth
if (GITHUB) truth = await githubTruth()
else {
  const truthDir = await mkdtemp(join(tmpdir(), 'envgit-demo-truth-'))
  await copyCorpus(truthDir)
  truth = await groundTruth(truthDir)
}
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
