# envgit

**Version control for the environment your coding agent works in.**

Coding agents such as Claude Code, Codex and Copilot CLI run for hours and execute thousands of commands, and afterwards you have a diff and a chat log. envgit records every step the agent takes in a sandbox — the command, the files it changed, the hosts it reached, what the policy denied — and snapshots the environment after each one. You can rewind to any step, fork from it, and stop the actions a rewind could never undo, such as a `git push` or a POST to a production API, before they go out.

```console
$ envgit init
initialized ~/myproject/.envgit
$ envgit run sh -c "sed -i '' s/hi/hello/ app.py"
envgit: step 0 recorded in session 20261027T200311-619e07
$ envgit run python3 app.py
hello
envgit: step 1 recorded in session 20261027T200311-619e07
$ envgit run curl -sS https://example.com
curl: (56) CONNECT tunnel failed, response 403
envgit: denied deny network-outbound example.com:443 (host is not on the allow list)
envgit: step 2 recorded in session 20261027T200311-619e07
$ envgit log
session 20261027T200311-619e07
  base  a49adcd7
    0  20:03:11  exec  exit 0   4e49b8f3  sh -c sed -i '' s/hi/hello/ app.py
    1  20:03:11  exec  exit 0   4e49b8f3  python3 app.py
    2  20:03:11  exec  exit 56  4e49b8f3  curl -sS https://example.com                                  1 denied
head: 2
$ envgit rewind base
envgit: rewound to base (3 step(s) undone)
```

| git | envgit |
|---|---|
| commit | a snapshot after every step: the workdir, or with the VM backend the whole machine, memory and running processes included |
| log | what each step did: command, exit code, files written and deleted, requests made, policy denials, irreversible actions |
| reset | `envgit rewind <step>` puts the environment back; the abandoned steps stay in the log as a branch |
| branch | `envgit fork <step> <dir>` materializes any step into a new directory with its own session |
| diff | the timeline UI shows what each step changed against its parent |
| — | **irreversible actions** (a push, a publish, a payment) are refused, or need a person's yes, before they leave the sandbox |

Sandboxes already isolate well: Seatbelt, bubblewrap, Firecracker. envgit adds what they don't: a record of what the agent did, the reason each action was allowed, and a way back.

## Quick start

envgit is not on npm yet; build it from source. It needs Node 22 or newer, and macOS or Linux. On Linux the sandbox also needs `bubblewrap`, `socat` and `ripgrep`.

```bash
git clone https://github.com/dingningpei/envgit.git
cd envgit && npm install && npm run build && npm link   # puts `envgit` on your PATH
```

Then, in a project:

```bash
envgit init              # creates .envgit/ with a default policy (.envgit/policy.yaml)
envgit run npm test      # runs in the sandbox and records a step
envgit log               # the steps so far
envgit ui --open         # the timeline in a browser
envgit rewind 0          # back to just after step 0
```

## Use it with your agent

| Agent | How | What becomes a step |
|---|---|---|
| **Claude Code** | `envgit claude [claude args]` | every tool call that can change files (Bash, Edit, Write, …), plus a checkpoint at the end of each turn |
| **Codex** | `envgit codex [codex args]` | every command Codex runs (in envgit's sandbox) and every `apply_patch` |
| **Copilot CLI** | `envgit hooks install copilot`, then run `copilot` in that folder (trust it; with `-p`, pass `--trust-folder`) | every shell command and file edit, plus a checkpoint at the end of each turn |
| **Any MCP client** | `claude mcp add envgit -- envgit mcp` (or your client's equivalent) | every call to its `execute` tool: a sandboxed JavaScript REPL |

- **Claude Code** runs entirely inside envgit's sandbox, behind its gate, with envgit's hooks added for that run only (`~/.claude` is not touched). It authenticates from the environment there: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`.
- **Codex** runs its commands through envgit itself. envgit implements Codex's exec-server protocol, so commands run in envgit's sandbox or VM and go through its policy. `~/.codex` is not touched.
- **Copilot CLI** has no per-run hooks, so `hooks install` writes `.github/hooks/envgit.json`. It contains this machine's paths; keep it out of commits.
- **Under Codex, Claude Code and `envgit run`**, irreversible actions are stopped at the HTTP(S) request, in the proxy — including Codex's own HTTP calls. **Under Copilot CLI** only the shell rules apply today, and those match command lines, which a variable or a subshell gets past; there envgit records, and refuses the obvious cases, but does not yet enforce.

The MCP server exposes one tool, `execute`, which runs JavaScript in a persistent REPL inside the sandbox. The capabilities your policy grants appear in it as async functions: `fs`, `http`, and the tools of any MCP server you list under `mcp:` (`await github.list_issues({ owner, repo })`), declared to the model as TypeScript generated from each tool's JSON Schema. Those servers run inside the sandbox too, so their own requests meet the same rules. Intermediate results stay in the REPL instead of the model's context: a large returned value comes back as `$1` with its type, long output is cut in the middle, and `sample()`, `schema()` and `assert()` let the model check data without printing it. In [our measurement](docs/demo-m1.md), made before these three, `execute` took 1.6× fewer tokens than one tool per capability on a small task, and 9.4× fewer on a large one.

## Policy

One file, `.envgit/policy.yaml`, drives the sandbox for every agent:

```yaml
filesystem:
  read:  { deny: ["~/.ssh", "~/.aws", "**/.env"], allow: ["."] }
  write: { allow: [".", "/tmp"], deny: [".env"] }
network:
  allow: ["api.github.com:443", "registry.npmjs.org"]
  l7:
    api.github.com: { methods: [GET] }          # everything else to this host is refused
irreversible:                                   # what rewind cannot undo
  - net: { host: "github.com", method: POST, path: "/**/git-receive-pack" }   # git push over HTTPS
  - net: { host: "registry.npmjs.org", method: PUT }                          # npm publish
  - shell: ["git push", "npm publish"]
    action: deny                                # or ask (the default), or allow (just mark the step)
mcp:                                            # MCP servers whose tools become REPL functions
  github:
    command: github-mcp-server
    args: [stdio, --read-only]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }   # from envgit's environment
snapshot:
  maxBytes: 10G                                 # drop the oldest rewind points to stay under this
```

- **Network rules:** when the policy has request-level rules, the sandbox proxy terminates TLS so it can judge each HTTP(S) request by method and path, and refuses tunnels it cannot see into (plain HTTP inside CONNECT, SOCKS, SSH over the proxy).
- **Shell rules:** these match the command line, including the commands inside an `sh -c` script. They are a best effort, so the network rules are what actually enforces.
- **Recording decisions:** every decision is recorded on the step, and the log and the UI mark the steps that reached outside.

See [`examples/policy.yaml`](examples/policy.yaml) and [design §3.2, §4](docs/design.md).

## Two backends

| | `srt` (default) | `vm` |
|---|---|---|
| Isolation | OS sandbox via [sandbox-runtime](https://github.com/anthropics/sandbox-runtime): Seatbelt on macOS, bubblewrap on Linux | a Firecracker microVM running Ubuntu 24.04 with git, Python, Node 24 and ripgrep |
| A snapshot holds | the workdir's files (content-addressed and incremental) | the whole machine: disk, memory and running processes |
| Rewind brings back | files | files, plus the processes that were running, with their state |
| Runs on | macOS, Linux | Apple-silicon Macs (M3 or later, macOS 15+), nested in a Virtualization-framework VM; arm64 Linux with KVM (plus `squashfs-tools`) |

To use the VM, set `backend: vm` in the policy, run `scripts/vm/build.sh` once, then run `envgit vm up`. The build script downloads pinned, checksummed kernels, Firecracker and images into `~/.cache/envgit/vm`, and prebuilds a warm base snapshot. After that, `vm up` takes about 2 s and a step about 0.4 s.

On the VM backend:
- **Host workdir:** it becomes a read-only mirror of the guest's `/work`, synced after every step. `envgit vm push <path>` sends your own edits in, as a step.
- **Snapshots:** they live on the host, so `envgit vm down` loses nothing (it checkpoints first), and `vm up` resumes with the same processes running.
- **Network:** the guest reaches it only through the host's proxy, only while a step runs, and under the same policy.

## Timeline

`envgit ui` serves a page on 127.0.0.1, with a random token in the URL:
- the session's steps as a tree, with the current branch highlighted;
- each step's command, effects, denials and irreversible marks, and, on srt, a diff of the files it changed;
- buttons to rewind or fork from any step.

The page refreshes as new steps are recorded, so you can watch an agent work.

## How it works

- **Each step** is one command, one REPL call, or one agent tool call. Steps are appended to `.envgit/sessions/<id>/steps.jsonl`, each pointing at its parent, so rewinding and then continuing creates a branch instead of losing history.
- **Snapshots on srt** are content-addressed manifests plus deduplicated blobs.
- **Snapshots on vm** are a full base snapshot plus Firecracker memory diffs along the parent chain. With `snapshot.maxBytes`, envgit drops the oldest rewind points first; on the VM it folds a dropped diff into its children.
- **Irreversible actions** are judged in two places: the egress proxy (srt's proxy, or the VM's vsock tunnel into it) and the agent hooks.

[`docs/design.md`](docs/design.md) has the full design. [`docs/spike-nested-firecracker.md`](docs/spike-nested-firecracker.md) covers how Firecracker runs nested on a Mac.

## Status

envgit is early and experimental: interfaces and on-disk formats may change.

What works today:
- the srt and VM backends, with rewind, fork, gc and the snapshot size cap;
- the MCP REPL;
- the Codex, Claude Code and Copilot CLI integrations, checked in real sessions;
- the timeline UI.

Known gaps (see [design §7](docs/design.md) for the full review and [§5](docs/design.md) for what is next):
- The VM backend is arm64 only; x86_64 is not built yet.
- The Codex integration relies on `codex exec-server`, which Codex marks as experimental. It was written against Codex 0.162.1.
- Under Copilot CLI, the agent runs its own tools outside envgit's sandbox. envgit can judge shell command lines there, but not individual HTTP requests — so there it records rather than enforces.
- The REPL connects stdio MCP servers only; remote (streamable HTTP) servers are not supported yet. A server gets the tokens you give it, and code in the REPL runs in the same sandbox, so it can read them too.
- With request-level network rules on, requests to IPv6-literal addresses (`http://[::1]/`) are refused: sandbox-runtime's Host check compares them in two different spellings.
- The VM backend on macOS is nested (a Firecracker VM inside a Virtualization-framework VM), which makes a warm step ≈ 1 s; it is for trying memory-level rewind. The intended production shape is Firecracker on a Linux host.
- On Linux, srt hides read-denied directories instead of refusing reads, so those denials don't show up in the log.

## License

[Apache-2.0](LICENSE)
