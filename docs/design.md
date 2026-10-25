# envgit — design notes

> Working document. Everything here is subject to change.

## 1. Problem

An agent session is a sequence of actions that mutate an environment. Today the only record is the chat transcript; the only recovery is "start over" or "ask the agent to fix it". Side effects that leave the sandbox (git push, outbound email, writes to a real database, paid API calls) are indistinguishable from local ones in the log and cannot be rolled back at all.

## 2. Core model

```
Session
 └── Step (one tool call / one REPL execution)
      ├── Action record   : command or code, inputs, start/end, exit status
      ├── Effects         : files read/written, hosts contacted, processes spawned, policy denials
      ├── Irreversible?   : flag + reason (left the sandbox boundary)
      └── Snapshot ref    : environment state *after* this step
```

- A **snapshot** is a backend-specific handle (Firecracker diff snapshot, overlayfs layer, VM checkpoint). Content-addressed; stored copy-on-write.
- A **fork** creates a new session whose first snapshot is an existing one.
- **Rewind** = fork at step N, then discard the old head (old history kept for audit).
- The **action log** is append-only and separate from snapshots; it survives even when snapshots are pruned.

## 3. Layers

### 3.1 Environment backends (`src/core/env`)

Interface sketch:

```ts
interface EnvBackend {
  create(spec: EnvSpec): Promise<Env>
  snapshot(env: Env): Promise<SnapshotId>
  restore(id: SnapshotId): Promise<Env>
  exec(env: Env, cmd: Command, policy: Policy): Promise<ExecResult>
  destroy(env: Env): Promise<void>
}
```

Planned backends, in order:

| Backend | Isolation | Snapshot | Use |
|---|---|---|---|
| `srt` (sandbox-runtime) | OS primitives, shares host kernel | fs-level only (overlay / git-like) | local interactive dev, reuses host toolchain |
| `docker` / `podman` | same tier as srt, packaged env | container commit | reproducible env |
| `firecracker` (Linux) | separate kernel | full memory+disk, ms restore | unattended, parallel, untrusted |
| `apple-vz` (macOS) | separate kernel | VM checkpoint | desktop-grade self-hosted VM |

Browser / desktop automation only works in the VM tier (user namespaces are blocked under srt; nothing below a VM contains a GUI).

### 3.2 Policy (`src/core/policy`)

One YAML/JSON file. Static sections are fixed at env creation; dynamic sections hot-reload.

```yaml
filesystem:
  read:  { deny: ["~/.ssh", "~/.aws", "**/.env"], allow: ["."] }
  write: { allow: [".", "/tmp"], deny: [".env"] }
network:
  allow: ["api.github.com:443", "registry.npmjs.org"]
  l7:
    api.github.com: { methods: [GET] }
capabilities:            # what the REPL exposes as functions
  github: [listIssues, getIssue]
  fs:     true
  shell:  false
irreversible:            # gated: require approval, always logged red
  - net: { host: "github.com", method: POST, path: "/repos/*/git/*" }
  - shell: ["git push", "npm publish"]
```

Compiles to: srt settings, Codex `config.toml` sandbox section, Copilot sandbox settings, and the REPL's injected globals. Enforcement is at the **effect** layer (syscalls, proxy), never by parsing agent code.

### 3.3 REPL (`src/repl`)

- QuickJS or isolated-vm; persistent across steps (variables survive).
- Tools (MCP, CLI, HTTP) injected as typed async functions per `capabilities`.
- Only `print()` / return value goes back to the model; everything else stays in the sandbox.
- Each `execute` is one Step → one snapshot.
- No shell-string API by default; typed command capabilities instead.

### 3.4 Adapters (`src/adapters`)

- `claude-code`, `codex`, `copilot`: translate policy to native config; expose envgit as a remote/self-hosted environment where the vendor protocol allows (Codex `exec-server --remote` first).
- `mcp`: expose the REPL as an MCP server so any client can use it without native support.

## 4. Irreversibility

Effects are classified at policy-compile time and confirmed at runtime by the proxy:

- **Reversible** — contained in the snapshot. Rewind restores fully.
- **Irreversible** — crossed the boundary. Gated (ask / deny) per policy; logged with a marker; rewind past one prints what cannot be undone.

The product promise is *audit + gate + in-sandbox rewind*, not a time machine.

## 5. Milestones

1. **M0** — `envgit init` / policy file / `envgit run <cmd>` on the srt backend with an action log.
2. **M1** — REPL with persistent state and capability injection, exposed as an MCP server. Demo: same task, 10× fewer tokens.
3. **M2** — Firecracker backend with per-step snapshots; `envgit log`, `envgit fork <step>`, `envgit rewind <step>`.
4. **M3** — Codex self-hosted environment adapter; irreversible-action gating through the egress proxy.
5. **M4** — Apple Virtualization backend; web UI timeline.

## 6. Prior art

- anthropics/sandbox-runtime — OS-primitive sandbox + proxy, credential masking.
- NVIDIA/OpenShell — container/microVM runtime with gateway, L7 egress policy.
- Cloudflare Code Mode, Anthropic programmatic tool calling — tools as code APIs.
- E2B / Daytona / Fly Sprites / Modal — hosted sandboxes with pause/resume.
- Remount — resumable agent sessions on your own infra.

None combine per-step snapshots, fork/rewind, an action log and irreversibility gating.
