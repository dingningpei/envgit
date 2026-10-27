/**
 * Claude Code and Copilot CLI both run hook commands around each tool call, with JSON on stdin.
 * This turns either payload into one shape envgit acts on (docs/design.md §3.4).
 */

export type Agent = 'claude-code' | 'copilot'

export interface ToolEvent {
  agent: Agent
  sessionId?: string
  cwd?: string
  /** The agent's own tool name, as given. */
  tool: string
  /** Set for shell tools: the command line the agent runs. */
  command?: string
  /** Set for file tools: the paths they name. */
  paths: string[]
  toolUseId?: string
  /** The raw tool input, for the step's record. */
  input: unknown
}

const SHELL = new Set(['bash', 'powershell', 'shell'])
const FILE = new Set(['edit', 'write', 'create', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor'])
/** Copilot's tool names for these, as its matcher needs them (seen: apply_patch in 1.0.104). */
export const COPILOT_WRITERS = 'bash|powershell|edit|create|write|apply_patch|str_replace_editor'

/** Tools whose calls can change files: those are the ones that become steps. */
export function changesFiles(tool: string): boolean {
  const t = tool.toLowerCase()
  return SHELL.has(t) || FILE.has(t)
}

export function normalize(agent: Agent, raw: Record<string, unknown>): ToolEvent {
  // Claude Code (and Copilot's Claude-format events) use snake_case; Copilot's own events camelCase.
  const tool = String(raw.tool_name ?? raw.toolName ?? '')
  const t = tool.toLowerCase()
  let input = raw.tool_input ?? raw.toolArgs ?? {}
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      // Not JSON: a shell tool's command line, or apply_patch's patch text.
      input = SHELL.has(t) ? { command: input } : { patch: input }
    }
  }
  const i = (input ?? {}) as Record<string, unknown>
  const paths = [i.file_path, i.path, i.notebook_path, ...(Array.isArray(i.paths) ? i.paths : [])].filter((p): p is string => typeof p === 'string')
  // apply_patch names its files inside the patch: `*** Add File: x`, `*** Update File: y`, `*** Delete File: z`.
  for (const v of Object.values(i)) if (typeof v === 'string') for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1]!.trim())
  return {
    agent,
    sessionId: (raw.session_id ?? raw.sessionId) as string | undefined,
    cwd: raw.cwd as string | undefined,
    tool,
    ...(SHELL.has(t) && typeof i.command === 'string' && { command: i.command }),
    paths,
    toolUseId: (raw.tool_use_id ?? raw.toolUseId) as string | undefined,
    input,
  }
}
