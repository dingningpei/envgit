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

- **M2.5 (vm backend, macOS and Linux arm64)** — `backend: vm` in the policy runs commands inside a Firecracker guest — on macOS nested in a Virtualization-framework microVM, on Linux directly on the host's KVM — and every step is a Firecracker diff snapshot: `envgit rewind` brings back files **and running processes**. `envgit vm up` boots it (and imports the workdir), the host workdir becomes a read-only mirror synced after every step (host edits that were not pushed are kept and reported, never overwritten), and `envgit vm push <path>` sends host edits in as a step. Snapshots are stored on the host in `.envgit/vm/snaps`, so `envgit vm down` loses nothing (it checkpoints the guest first): `vm up` resumes the session with its processes, `rewind` works while the VM is down, and `envgit fork` works on vm sessions too. L2 runs the Ubuntu 24.04 server image with git, python3 and Node 24, and `envgit mcp` works on this backend too — with the REPL worker inside the VM, so `rewind` brings back its variables, not just files. L2 reaches the network only through a vsock tunnel to the host, where the same srt proxy and irreversible-action gate as on srt judge each request — and only while a step runs. Needs an M3+ Mac on macOS 15+, or an arm64 Linux host with KVM plus bubblewrap, socat, ripgrep and squashfs-tools (x86_64 is not built yet), and `scripts/vm/build.sh` (downloads pinned kernels/Firecracker into `~/.cache/envgit/vm`, and prebuilds a warmed-up base snapshot that new sessions restore instead of booting: `vm up` ≈ 2 s, first node ≈ 1 s). See [design §3.6](docs/design.md) and the [spike](docs/spike-nested-firecracker.md).

- **M3 (gating)** — irreversible actions are gated, not just logged. With request rules in the policy, the sandbox proxy terminates TLS and judges every HTTP(S) request: `network.l7` denies what it does not list, and an `irreversible` rule (`git push` over HTTPS, `npm publish`, a POST to an API) either asks — at the terminal for `envgit run`, through MCP elicitation for `envgit mcp` — or is denied / allowed outright per its `action`. With no one to ask, `ask` denies. The decision is recorded on the step, and `log` / `rewind` show which steps reached outside. See [design §4](docs/design.md).
- **M3 (Codex)** — `envgit codex [args]` runs Codex with envgit as its environment: every command Codex runs goes through envgit's sandbox, policy and gate and is a step, every apply_patch a step, so `envgit log` / `rewind` / `fork` cover a Codex session like any other. It speaks Codex's exec-server protocol (Codex 0.162.1; experimental upstream) on a loopback WebSocket and leaves `~/.codex` alone; `envgit codex-exec-server` is the stdio form for `environments.toml`. Works on both backends: on `backend: vm` Codex's commands run in the VM, so `rewind` brings back their processes too. See [design §3.4](docs/design.md).
- **M4 (timeline)** — `envgit ui` opens the session in a browser: the step tree with the current branch highlighted, each step's command, exit code, effects, denials and irreversible marks, and on srt a diff of what it changed; rewind or fork from any step (it runs the CLI, so the same checks apply). It refreshes as steps land, so you can watch Codex or an MCP client work. Loopback only, with a token in the URL. See [design §3.7](docs/design.md).

```bash
npm install && npm run build
cd your-project && node /path/to/envgit/dist/cli/index.js init
claude mcp add envgit -- node /path/to/envgit/dist/cli/index.js mcp
```

## License

Apache-2.0
