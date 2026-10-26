# envgit

**Version control for agent execution environments.**

Coding agents (Claude Code, Codex, Copilot CLI, …) run for hours, execute thousands of commands, and leave you with a diff and a chat log. envgit records what actually happened, lets you fork or rewind the environment at any step, and gates the actions that cannot be undone.

```
git            → versions file content
envgit         → versions environment state + the actions that produced it
```

| git | envgit |
|---|---|
| commit | snapshot of the whole environment after a step (fs + memory + processes) |
| branch | fork the environment at any step and run two approaches in parallel |
| log | what the agent did: commands, files read/written, network calls, policy denials, tokens |
| diff | file changes **and** action sequence between two snapshots |
| reset | rewind the environment to any earlier step |
| — | **egress policy**: side effects outside the sandbox (push, email, paid APIs) are gated or flagged as irreversible |

## Why

Isolation is infrastructure — bubblewrap, Seatbelt, Firecracker, gVisor already do it well. What nobody provides is **governance**: knowing what the agent did, why it was allowed, and being able to go back. envgit sits on top of existing sandboxes and adds that layer.

## Three layers

1. **Environment backend** — pluggable: local OS primitives (via [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)), containers, microVMs with snapshots (Firecracker, Apple Virtualization).
2. **Policy** — one declarative file that drives filesystem / network / capability rules across all agents, and marks which actions are irreversible.
3. **REPL** — a persistent, capability-scoped code execution environment (Code Mode style) where MCP tools, CLIs and HTTP are exposed as typed functions and intermediate results never enter the model context.

## Status

Early. See [`docs/design.md`](docs/design.md) for the plan.

- **M0** — `envgit init`, `envgit run <cmd...>`: runs a command under [`sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) with the policy in `.envgit/policy.yaml` and appends a step to `.envgit/sessions/<id>/steps.jsonl`.
- **M1** — `envgit mcp`: a persistent JavaScript REPL running inside the sandbox, exposed as one MCP tool, `execute`. Capabilities listed under `capabilities:` in the policy (`fs`, `http`, `github: [listIssues, getIssue]`) are injected as async functions; each call is logged as a step with the files and hosts it touched or was denied. Measured against one-tool-per-capability: 1.6× fewer context tokens on a small task, 9.4× on a large one ([demo](docs/demo-m1.md)).

- **M2 (srt)** — every step snapshots the workdir (content-addressed, incremental). `envgit log` shows the chain, `envgit rewind <step|base>` restores it in place and keeps the abandoned steps in the log, `envgit fork <step> <dir>` materializes a step into a new directory, `envgit session new` starts a fresh session and `envgit gc` drops snapshots nothing refers to. A running `envgit mcp` notices a rewind and resets its REPL. Files only, not memory or processes.

- **M2.5 (macOS, vm backend)** — `backend: vm` in the policy runs commands inside a Firecracker guest nested in a Virtualization-framework microVM, and every step is a Firecracker diff snapshot: `envgit rewind` brings back files **and running processes**. `envgit vm up` boots it (and imports the workdir), the host workdir becomes a read-only mirror synced after every step, and `envgit vm push <path>` sends host edits in as a step. Needs an M3+ Mac on macOS 15+ and `scripts/vm/build.sh` (downloads pinned kernels/Firecracker into `~/.cache/envgit/vm`). See [design §3.6](docs/design.md) and the [spike](docs/spike-nested-firecracker.md).

```bash
npm install && npm run build
cd your-project && node /path/to/envgit/dist/cli/index.js init
claude mcp add envgit -- node /path/to/envgit/dist/cli/index.js mcp
```

## License

Apache-2.0
