#!/usr/bin/env node
import { access, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveMcp } from '../adapters/mcp/server.js'
import { SrtBackend } from '../core/env/srt.js'
import { matchIrreversible } from '../core/policy/compile.js'
import { loadPolicy } from '../core/policy/load.js'
import { appendStep, nextStepIndex, openSession, type Step } from '../core/snapshot/log.js'
import { ReplSession } from '../repl/session.js'
import { runWorker } from '../repl/worker.js'

const [cmd = 'help', ...args] = process.argv.slice(2)

const help = `envgit — version control for agent execution environments

  envgit init            create .envgit/ and a default policy
  envgit run <cmd...>    run a command in the sandbox, record a step
  envgit mcp [--tools]   serve the sandboxed REPL as an MCP server on stdio
                         (--tools: one MCP tool per capability instead of execute)
  envgit log             show steps
  envgit fork <step>     fork the environment at a step
  envgit rewind <step>   rewind the environment to a step

(log, fork and rewind are stubs — see docs/design.md)`

const ROOT = join(process.cwd(), '.envgit')
const POLICY = join(ROOT, 'policy.yaml')
const DEFAULT_POLICY = fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url))
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s)

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function init(): Promise<number> {
  if (await exists(POLICY)) {
    console.error(`envgit: ${POLICY} already exists`)
    return 1
  }
  await mkdir(join(ROOT, 'sessions'), { recursive: true })
  await copyFile(DEFAULT_POLICY, POLICY)
  console.log(`initialized ${ROOT}`)
  return 0
}

async function run(argv: string[]): Promise<number> {
  if (argv[0] === '--') argv = argv.slice(1)
  if (argv.length === 0) {
    console.error('usage: envgit run <cmd...>')
    return 2
  }
  if (!(await exists(POLICY))) {
    console.error('envgit: no .envgit/policy.yaml here — run `envgit init` first')
    return 1
  }
  const policy = await loadPolicy(POLICY)
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)
  const irreversible = matchIrreversible(policy, argv)
  if (irreversible) console.error(red(`envgit: irreversible action (${irreversible}) — not gated in M0, logging only`))

  const env = await backend.create({ workdir: process.cwd(), policy })
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  try {
    const startedAt = new Date().toISOString()
    const result = await backend.exec(env, { argv }, ac.signal)
    const step: Step = {
      index: await nextStepIndex(session.dir),
      startedAt,
      endedAt: new Date().toISOString(),
      action: { type: 'exec', input: JSON.stringify(argv) },
      exitCode: result.exitCode,
      effects: result.effects,
      ...(irreversible && { irreversible: { reason: irreversible } }),
    }
    await appendStep(session.dir, step)
    for (const e of result.effects) {
      if (e.kind === 'policy' && /\b(file|network)-\S+\s+\S/.test(e.reason)) console.error(red(`envgit: denied ${e.reason}`))
    }
    console.error(`envgit: step ${step.index} recorded in session ${session.meta.id}`)
    return result.exitCode
  } finally {
    process.off('SIGINT', onSigint)
    await backend.destroy(env)
  }
}

async function mcp(mode: 'repl' | 'tools'): Promise<number> {
  // stdout carries JSON-RPC; keep every diagnostic on stderr.
  console.log = console.error
  if (!(await exists(POLICY))) {
    console.error('envgit: no .envgit/policy.yaml here — run `envgit init` first')
    return 1
  }
  const policy = await loadPolicy(POLICY)
  const backend = new SrtBackend()
  const session = await openSession(ROOT, backend.name)
  const env = await backend.create({ workdir: process.cwd(), policy })
  const repl = new ReplSession(backend, env, policy, session.dir)
  try {
    await serveMcp(repl, policy, process.cwd(), mode)
    return 0
  } finally {
    await repl.close()
    await backend.destroy(env)
  }
}

let code: number
try {
  switch (cmd) {
    case 'init':
      code = await init()
      break
    case 'run':
      code = await run(args)
      break
    case 'mcp':
      if (args[0] === '--worker') {
        await runWorker()
        code = 0
      } else {
        code = await mcp(args[0] === '--tools' ? 'tools' : 'repl')
      }
      break
    default:
      console.log(help)
      code = 0
  }
} catch (e) {
  console.error(`envgit: ${e instanceof Error ? e.message : String(e)}`)
  code = 1
}
process.exit(code)
