/** Transports for the Codex exec-server adapter: stdio (environments.toml) and loopback WebSocket (`envgit codex`). */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { CodexExecServer, type CodexExecServerOptions } from './exec-server.js'
import { listenWs, type WsConnection } from './ws.js'

type Options = Omit<CodexExecServerOptions, 'send'>

/** Serves one Codex on stdin/stdout, one JSON-RPC message per line, until stdin closes. */
export async function serveCodexStdio(o: Options): Promise<void> {
  const server = new CodexExecServer({ ...o, send: text => process.stdout.write(text + '\n') })
  await server.start()
  let buf = ''
  process.stdin.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) server.handle(line)
    }
  })
  await new Promise<void>(r => process.stdin.once('end', r))
  await server.close()
}

/**
 * Runs `agent` (Codex) with CODEX_EXEC_SERVER_URL pointing at envgit, so that run's commands and
 * file operations go through envgit; ~/.codex is not touched. The URL's random path is the only
 * credential, since Codex sends none for this variable. Returns the agent's exit code.
 */
export async function runCodexWs(o: Options, agent: string[]): Promise<number> {
  let conn: WsConnection | undefined
  const server = new CodexExecServer({ ...o, send: text => conn?.send(text) })
  await server.start()
  const ws = await listenWs(`/${randomBytes(24).toString('base64url')}`, c => {
    // A reconnect replaces the old connection; processes and the session carry on.
    conn = c
    c.onMessage(text => server.handle(text))
  })
  // Codex owns the terminal and its own Ctrl-C; envgit stays up until it exits.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    const child = spawn(agent[0]!, agent.slice(1), { stdio: 'inherit', env: { ...process.env, CODEX_EXEC_SERVER_URL: ws.url } })
    return await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code, sig) => resolve(code ?? (sig ? 128 + 2 : 1)))
    })
  } finally {
    process.off('SIGINT', ignore)
    await server.close()
    await ws.close()
  }
}
