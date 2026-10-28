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
  fs:     true
  shell:  false
  github: [list_issues, get_issue]   # an MCP server below; a list keeps only those tools
mcp:                     # MCP servers whose tools become REPL functions (§3.3)
  github: { command: github-mcp-server, args: [stdio, --read-only], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } }
irreversible:            # gated (§4): ask (default) / deny / allow, always logged red; first match wins
  - net: { host: "github.com", method: POST, path: "/me/scratch.git/git-receive-pack" }
    action: allow        # before the preset, so it overrides it
  - net: { host: "deploy.example.com", method: [POST, PUT], path: ["/v1/releases", "/v1/releases/**"] }
    name: "release"      # the label in messages and the log
  - preset: default      # envgit's stock rules, expanded here (`action: deny` would refuse them all)
```

Compiles to: srt settings, Codex `config.toml` sandbox section, Copilot sandbox settings, and the REPL's injected globals. Enforcement is at the **effect** layer (syscalls, proxy), never by parsing agent code.

### 3.3 REPL (`src/repl`)

- `node:vm` context in a long-lived worker process that runs under the env backend (srt in M1); the backend is the security boundary, `node:vm` only provides persistence. Persistent across steps (variables survive). The engine sits behind an `Engine` interface so QuickJS / isolated-vm can slot in where an in-process boundary is wanted.
- Tools injected as typed async functions per `capabilities`: `fs`, `http` (`fetch`), and each MCP server under `mcp:` (`src/core/mcp`).
  - **MCP servers run inside the sandbox.** The worker starts each one (stdio) as its own child, so a server's file access and requests are the sandbox's to allow and the gate's to judge, and land on the REPL step that called it — like everything else the step does. A server run by envgit outside would be a hole: its requests would never reach the proxy. On vm the server runs in L2, part of the snapshot, so rewind brings it back as it was. The client is a hand-written minimum (initialize, `tools/list` with paging, `tools/call`; server requests other than ping are refused), dependency-free so the vm worker stays a few files.
  - Each tool becomes `<server>.<tool>(args)` (quoted when the name is not an identifier). Its declaration is TypeScript printed from the tool's `inputSchema` (and `outputSchema`, if any), descriptions as JSDoc, so the model sees what to pass. A result comes back as `structuredContent` when there is one, else its single text block parsed as JSON when it parses, else as text; `isError` throws.
  - `capabilities.<server>: [tools]` keeps only those tools, `false` turns the server off. `${VAR}` in a server's `env` is filled in by envgit outside the sandbox (on vm the worker's environment is the guest's). A token handed to a server sits in the same sandbox as the REPL's code, which can read it: `node:vm` is not a boundary (above).
  - The declarations are known only once the servers answer, so `envgit mcp` starts the worker before it serves and asks it (`describe`, not a step); a server that will not start stops `envgit mcp` with its stderr. `envgit mcp --tools` serves the same functions as one MCP tool each, with the schemas the servers gave, each call still a REPL step: the comparison arm for the demo.
  - Not yet: remote (streamable HTTP) servers; server notifications such as `tools/list_changed`.
- Only `print()` / return value goes back to the model; everything else stays in the sandbox (`src/repl/inspect.ts`):
  - A returned array or object whose printout is over 4,000 characters is kept in the context as `$1`, `$2`, … (like Jupyter's `Out[n]`) and comes back as one line with its type, e.g. `$1 = Array(150): 18410 characters if printed, so it stays in the sandbox. Type: { number: number; labels?: string[] }[]`. `$n` is the value itself: `$1.length`, `$1.slice(0, 20)`. A returned string is printed: it is text the code made to be read, often the answer (the first rerun handled strings too, and the model had to `print($1)` its own answer).
  - Output beyond 40,000 characters is cut in the middle (head and the last 5,000), with a line saying how much was cut — under the ~65k at which Claude Code swaps a result for a file the model cannot read, above the ~20k answer of the demo's large corpus (a 20,000 cap cut it in the first rerun).
  - `sample(x, n)` (items spread across an array, first and last included), `schema(x)` (the value's type, array elements merged, keys missing in some optional, in the declarations' notation) and `assert(cond, message)` are injected, so the model can check its code's result without printing the data.
  - `envgit mcp --tools` results bypass both (a raw cell): a tool result there is what the server gave, as with any tool.
- Each `execute` is one Step → one snapshot. On the vm backend the worker runs inside the guest and
  is part of that snapshot, so `rewind` restores REPL variables too (§3.6); on srt it resets them.
- Effects for a REPL step are recorded by the injected capability wrappers (files read/written, hosts contacted, denials), since the macOS sandbox violation log drops events for long-lived processes; the backend's violation log is a best-effort supplement. On Linux srt hides a read-denied directory under an empty tmpfs instead of refusing the read, so such reads come back empty and no denial is recorded; on macOS Seatbelt refuses them and the step records `denied`.
- No shell-string API by default; typed command capabilities instead.

### 3.4 Adapters (`src/adapters`)

- `claude-code`, `copilot` (`src/adapters/hooks`): neither hands its tools to an external environment, but both run hook commands around each tool call with the call as JSON on stdin, and envgit records through those. The agent still executes the tool itself, in its own sandbox; `envgit hook <agent> <event>` does the rest:
  - **pre** (before a tool runs): takes the session's base snapshot on first use, and judges shell commands (`Bash`/`bash`, `PowerShell`) against the shell `irreversible` rules, split as for Codex. A `deny` rule refuses the call; an `ask` rule answers `ask`, so the agent's own approval prompt asks the person (the step is then marked irreversible, "approved in <agent>").
  - **post** (after a tool that can change files: Bash, PowerShell, Monitor, Edit, Write, NotebookEdit; Copilot's bash, powershell, edit, create, apply_patch — 1.0.104 edits with apply_patch, whose files are named inside the patch text): an fs-level snapshot of the workdir as a step (`exec` with the command, or `fs` with the paths), its effects the files that differ from the head's snapshot, with the agent, tool and tool-call id. Copilot's `postToolUseFailure` records it with exit 1.
  - **stop** (end of a turn: Claude Code's `Stop`, Copilot's `agentStop`): a `ckpt` step if the workdir changed outside tool calls — a background process's writes, which `PostToolUse` cannot see.
  - A hook never wedges the agent: it exits 0, errors go to stderr, a failing pre hook allows. In a directory without `.envgit` it does nothing; with `backend: vm` it records nothing (the tools run on the host).
  - `envgit claude [args]` runs the whole `claude` process inside envgit's srt sandbox, behind the gate (`src/adapters/hooks/claude-run.ts`). Its Bash, hooks and MCP servers are its children, so every request any of them makes goes through envgit's proxy: `network.l7` and irreversible net rules apply at the HTTPS request, as under `envgit run`, not only the shell rules' command-line matching. `--settings <json>` adds the hooks for that run (no change to `~/.claude`) and turns Claude Code's own sandbox off, so there is one sandbox, not two nested — which also means Claude Code no longer auto-allows Bash because it is sandboxed: interactive runs ask per command, and `-p` runs need `--allowedTools`.
    - What it needs inside, beyond the policy: `~/.claude`, `~/.claude.json*`, its caches and the temp dir writable, and its own temp root (`CLAUDE_CODE_TMPDIR`, set to a per-run directory — by default it uses `/tmp/claude-<uid>`, where its Bash tool makes its working dirs); its own hosts (`api.anthropic.com`, `claude.ai`, `platform.claude.com`, `mcp-proxy.anthropic.com`) always allowed — and, when the policy has request rules, decrypted and judged like any host (Claude Code trusts srt's CA through `NODE_EXTRA_CA_CERTS`; an undecrypted host would be an opaque tunnel, which the gate refuses). envgit's proxy then sees Claude Code's API requests; the gate records host, method and path, never headers or bodies. Non-essential telemetry is off. Bash children can reach those hosts too.
    - Credentials come from the environment only: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, and `envgit claude` refuses to start without one. The usual login (the macOS keychain, `~/.claude/.credentials.json` on Linux) is out of reach on purpose: a first attempt that let the sandbox use the keychain logged the user out — the OAuth refresh rotated the token inside the sandbox and could not save the new one — and keychain access would let any sandboxed command read the token.
    - Hooks run inside the sandbox and cannot write `.envgit`, so they relay: each writes its event into a spool directory the sandbox may write and waits; `envgit claude`, outside, handles it with the same code as above and writes back the reply (`src/adapters/hooks/spool.ts`). Each step also carries what the gate judged and srt denied since the previous one (file and network denials; srt's sysctl/mach noise is left out). After claude exits, envgit records a final checkpoint itself, since a crash or Ctrl-C skips the Stop hook.
    - Plugins and their hooks run inside the sandbox too, so their writes outside the policy (their own state under `~/.config`, an npm cache) and their hosts are refused like any other.
    - Checked with a real Claude Code 2.1.300 session (`-p`, token from `claude setup-token`), a policy with only a `net` rule on `POST /deploy` and a local stand-in server: Claude's Write became an `fs` step, its `curl -X POST …/deploy` got envgit's refusal from the proxy and the step a denied `net` effect with the rule, and the server saw only the later `GET /status`. The test suite proves the same with a stand-in agent in srt, including a POST no command-line rule could match.
  - Copilot CLI takes no per-invocation hooks, so `envgit hooks install copilot` writes `.github/hooks/envgit.json` (version 1; `uninstall` removes it). It names this machine's node and envgit, so it is not for committing. Copilot loads a repository's hooks only from a trusted folder: in `-p` mode pass `--trust-folder`, or the hooks silently do not run.
  - Checked against real sessions (Claude Code 2.1.300 through `envgit claude -p`, Copilot CLI 1.0.104 with installed hooks), the same task in each: a file created and edited (two `fs` steps), a command run (`exec`), `git push` refused with envgit's reason passed to the model, and a background write caught by the end-of-turn `ckpt`; rewind then restored the first version. Tests replay hook payloads and use a stand-in for `claude`.
- `codex` (`src/adapters/codex`, written against Codex 0.162.1, whose `codex exec-server` is still marked experimental): Codex sends every command and file operation of a turn to an *exec-server* — JSON-RPC: `process/start|read|write|signal|terminate` with `process/output|exited|closed` notifications, and `fs/*` — and envgit stands in as that server. `envgit codex [args]` runs Codex with `CODEX_EXEC_SERVER_URL` pointing at a loopback WebSocket on a random path (the URL is the only credential Codex sends for it), so `~/.codex` is not touched; `envgit codex-exec-server` serves the same over stdio for an `environments.toml` entry (`program = "envgit"`). Behind it, envgit runs a real `codex exec-server --listen stdio`:
  - `process/start` is run by envgit's backend — srt's sandbox, envgit's policy and gate, not the sandbox Codex asks for — and each process is a step (exec, its argv, Codex's tool-call id). The step is recorded before `process/exited` goes back: Codex's next request may build on it. Output streams as it comes and stays buffered for `process/read`.
  - `fs/writeFile|createDirectory|remove|copy` (apply_patch's path) are forwarded and recorded as one `fs` step per burst — closed by 150 ms of quiet or the next `process/start`.
  - `http/request` (Codex's executor-side HTTP: remote MCP servers, OAuth discovery) is made by envgit, not forwarded: a helper (`envgit codex-http-helper`, `src/adapters/codex/http-helper.ts`) runs inside the sandbox — on vm, its logic in the guest — so the request goes through the proxy and the gate like a command's; `https://` by `fetch`, `http://` as an ordinary proxied request (a CONNECT would be an opaque tunnel), loopback included (srt's `NO_PROXY` is cleared for it). Streamed responses come back as `http/request/bodyDelta` (on vm in one piece). What the gate judged lands on the next step.
  - Everything else — metadata and reads (Codex walks up for `.git`, `AGENTS.md`, skills), `environmentConfig/read`, capability discovery — is forwarded unchanged.
  - `initialize` answers with the real server's executor info, minus `fileWriteStreaming`, `sandboxedFileStreaming`, `networkProxyLaunch` and `shellSnapshotV2`, which envgit does not serve.
  - Shell `irreversible` rules see the commands inside Codex's `zsh -lc '<script>'`, split on newlines, `;`, `&&`, `||` and `|` (a best effort; net rules enforce). `ask` rules deny: the protocol has no way to ask Codex's user, and Codex owns the terminal.
  - On the vm backend (`envgit vm up` first) commands run in L2, in the `/work` directory matching Codex's cwd, as vm steps — snapshot, mirror sync, egress through the host gate — so `rewind` brings back processes too. `initialize` tells Codex the guest's shell (bash; L2 has no zsh) and OS, and drops the host's `prependPathDirs`. Codex's fs calls still go to the host workdir, which mirrors /work after every step — and since commands show Codex `/work` (`pwd`), `file:///work/…` in any request is read as the host workdir; its writes and removals are pushed into the guest, like `envgit vm push`, as the fs step. L2's exec returns only when the command ends, so output comes in one piece, commands run one at a time, and `process/terminate` cannot stop one (L2's 10-minute limit does): a command that never exits, such as a dev server, holds up every later one until then, so on vm start servers in the background (`… &`; L2 stops waiting for a backgrounded child's output after 200 ms). Absolute host paths in a command do not exist in the guest.
  - Denials as Codex sees them: `process/exited` always says `sandboxDenied: false`. On srt the reported sandbox type is Seatbelt / seccomp, so Codex's own heuristic reads a failed command whose output says "operation not permitted", "permission denied" and the like as a sandbox denial (its TUI may then offer to retry with more permissions, which envgit's policy judges the same way again); on vm the type is `none`, which that heuristic never flags.
  - Seen in a capture of a real `codex exec`: one non-PTY process per shell tool call; a real `codex exec` through `envgit codex` (apply_patch on two files, then commands) recorded exec, fs, exec on srt, and the same on vm — where it also showed Codex naming `/work/…` paths and reaching for `rg`, hence the mapping above and ripgrep in L2. Tests replay the protocol with a scripted client, never OpenAI. Interactive commands (`tty` / `pipeStdin`, the TUI's write_stdin) get a stdin pipe on srt that `process/write` feeds, with ^C as SIGINT and ^D as end of input — but no PTY (that needs a native module), so programs see no terminal; on vm, L2's exec has no stdin and writes get `stdinClosed`. Not covered: concurrent commands' net effects on srt (the gate is per process, so they are attributed to whichever ends first).
- `mcp`: expose the REPL as an MCP server so any client can use it without native support.

### 3.5 fs-level snapshots on srt (`src/core/snapshot/store.ts`)

- Content-addressed: blobs at `.envgit/objects/<sha256>` (APFS clones where available), one manifest per
  snapshot at `.envgit/snapshots/<id>.json`. The id hashes paths, kinds, modes, file hashes and link
  targets — not mtimes — so an unchanged tree always gets the same id.
- Incremental: a file whose size, mtime and mode match the previous manifest is not re-read, unless its
  mtime is within 2 s of that snapshot (git's "racy" case: it could have changed again unnoticed).
- Only dirs, regular files and symlinks are tracked; FIFOs, sockets and devices are neither snapshotted
  nor removed by a restore.
- Each session has a **base** snapshot (before its first step) and a **head**. A step's `parent` is the
  head when it ran; `rewind N` restores N's snapshot and moves head, leaving the abandoned steps in the
  log. `fork N <dir>` restores into a new directory (outside the workdir) with its own `.envgit` and
  `forkedFrom`; it is built in `<dir>.forking` and renamed into place, so a crashed fork leaves no
  half-built target and a retry clears the leftover. `session new` starts a fresh session; old ones
  stay for audit.
- `rewind` refuses when the workdir differs from head's snapshot (edits made outside envgit) unless
  `--force`, refuses while `.envgit/busy` names a live process (a step is running), and prints every
  irreversible step it steps back over. It writes `.envgit/restoring` first; any later command that
  finds the marker finishes the restore (restores only touch what differs, so redoing one is safe).
- `envgit mcp` checks head before each `execute`; if a rewind moved it, the worker is restarted and the
  result starts with a notice that REPL variables were reset.
- `.envgit/busy` is `{pid, started}` (`ps -o lstart`), created with `O_EXCL`. A holder counts as alive
  only if the pid exists and its start time matches, so a reused pid does not keep the lock; a stale
  lock is moved aside atomically and dropped only if it is still the record judged stale.
- `gc` keeps every snapshot any session refers to (abandoned branches included) and anything written in
  the last hour (blobs land before their manifest, so a snapshot in progress elsewhere is not cut);
  `.tmp` blobs left by a crashed write are swept after the same grace.
- `.envgit` is always excluded from snapshots and always in srt's `denyWrite`, so the sandbox cannot
  rewrite its own history. `snapshot.exclude` in the policy leaves more paths out.
- Limits: files only, no memory or processes — that needs the VM tier.
- **Size cap** (`src/core/snapshot/cap.ts`, both backends): with `snapshot.maxBytes` (`500M`, `10G`, or
  bytes) in the policy, envgit measures the snapshots after each recorded step — at most once a minute
  while under the cap, every step once over — and drops rewind points until they fit: first what
  nothing refers to, then whole older sessions, then the current session's abandoned branches (whole
  subtrees, oldest first), then its current branch from the oldest step on, always keeping base, head
  and the last 10 steps. A dropped step stays in the log (`log` and the UI mark it `pruned`; `rewind`
  and `fork` to it say why they cannot); the session's `pruned` file lists steps, not snapshot ids,
  because srt ids are content hashes another step may share. It runs under the busy lock, so gc needs
  no grace period there; `envgit gc` runs it too. On vm, dropping a step on the current branch first
  folds its diff into each child (§3.6), so the children no longer build on it.

### 3.6 VM backend: Firecracker, nested on macOS, direct on Linux (`src/core/env/vm.ts`, `vm/`)

Memory + process + file snapshots, from the spike in [`spike-nested-firecracker.md`](spike-nested-firecracker.md).

```
envgit (TS) ──unix socket── envgit-vm (Swift, Virtualization.framework) ──vsock── L1 supervisor (Go /init)
                                                                                     │ Firecracker API + vsock
                                                                                     └── L2 agent (Go /init) → chroot into the CI rootfs
```

- **Lifetime:** `envgit vm up` boots L1 and either resumes the current vm session at its head (from
  the snapshots on the host) or, with no such session or `--new`, boots a fresh L2 and imports the
  workdir; `envgit vm down` first checkpoints the guest as a step (`ckpt`, "before vm down": what
  background processes did since the last step), then stops both, so it loses nothing and `vm up`
  resumes at that checkpoint. `rewind` boots the VM itself if it is down.
  `run` against a live VM costs one exec round trip, one diff snapshot and an incremental mirror sync.
  `scripts/vm/build.sh` writes a stamp of its output and `vm up` records the stamp it booted; when
  they differ (a rebuild since), `vm up`, `run` and `push` checkpoint the guest as a step (`ckpt` in
  the log: background processes may have moved on since the last step), stop the VM, boot the new
  build and restore that checkpoint (≈ 2 s); `rewind` just restarts, since it replaces the state anyway.
- **L1** is the Ubuntu arm64 generic kernel with an initramfs holding our Go supervisor, Firecracker,
  `rebase-snap`, the L2 kernel and initrd, and the vsock + virtiofs modules taken from the matching
  `linux-modules` package (the same approach Claude's desktop VM takes). Two read-only disks (L2's
  images, passed through to Firecracker as L2's drives, so they are read on demand rather than held
  in RAM), no network; one virtiofs share, the workdir's `.envgit/vm/snaps`, where every snapshot goes.
- **L2** boots the Firecracker CI kernel with our Go agent as its initrd. The agent overlays a tmpfs
  on two read-only squashfs layers — Node 24 and ripgrep (`/usr/local`; agents such as Codex search
  with `rg`) over the Ubuntu 24.04 server cloud image
  (git, python3, curl, build tools from apt are a `run` away now that there is egress) — and runs
  commands via `chroot` with `/work` as cwd. Child processes outlive the command that started them;
  the agent reaps them as PID 1. Both images are pinned (the cloud image by dated release and the
  checksum Ubuntu publishes, Node by `SHASUMS256.txt`). macOS has no `mksquashfs`, but the cloud image
  does: `build.sh` boots the VM once on the bare image and lets L2 pack the Node layer (cached; ≈ 2.5
  min the first time). A memory snapshot holds the page cache of these disks, so it only restores onto
  the images it was taken on: a session records `vmImage` and is not resumed or rewound on others.
  The agent itself lives in guest memory too, so new agent features need a new session (`vm up --new`).
- **Workdir ownership:** while a VM session runs, files live in L2's `/work` (tmpfs, so the memory
  snapshot contains them — memory, processes and files are one consistent unit). The host workdir is
  a read-only mirror, synced from L2 after every step and after a rewind. Host edits go in through
  `envgit vm push`, which is recorded as a step so it can be rewound. The mirror is not chmod'ed
  read-only — that would get in the way of the edit-then-push workflow — instead it guards host
  edits: `mirror.json` records the hash of every file it wrote, and a host file that no longer
  matches (edited, or created, on the host and not pushed) is kept and reported as a conflict
  rather than overwritten or deleted. Sync is incremental: the host sends the guest key (inode, size,
  ctime, mode) of what it holds, L2 replies with its full listing and a tar of only the entries whose
  key differs. The paths a step wrote or deleted in `/work` are recorded as its `fs` effects (at most
1000 of each per step). Later,
  `/work` moves to a host-side disk image for capacity (APFS clone per snapshot, same ownership model).
- **Prebuilt base:** a cold-booted L2 pays for every page it touches first (below), a restored one
  far less, so `build.sh` boots one guest, runs node, npm, python and git in it once, and keeps its
  full snapshot in `build/base/` (with the build stamp; ≈ 175 MB, ≈ 20 s to make). A new session
  clones it into `.envgit/vm/snaps/` and restores it instead of booting — `vm up` ≈ 2 s instead of
  6 s, the first node ≈ 1 s instead of 11 s — and falls back to a cold boot when the base belongs to
  another build. Sessions restored from one snapshot do not share random numbers: Firecracker gives
  each restored guest a new VMGenID and the L2 kernel reseeds its CRNG on it.
- **Snapshots:** a full snapshot of the base (prebuilt, or taken after a cold boot), then one Firecracker diff per step; the diff
  holds the pages dirtied since the previous snapshot or restore, so its size ≈ what the step wrote.
  A step's memory = base + the diffs along its `parent` chain, merged with `rebase-snap` at restore.
  vsock connections do not survive a snapshot load, so every request opens a new connection.
- **Snapshots on the host:** L1 writes each snapshot to tmpfs, resumes the guest, then packs it into
  `.envgit/vm/snaps/<id>/` (`meta.json` with parent and kind, `state`, and memory as `mem.idx` —
  the data extents — plus `mem.dat`) before acknowledging it. Extents are explicit because in a diff a
  hole means "page not in this diff", unlike a page written with zeros, and we do not rely on virtiofs
  to keep holes; a full snapshot (written densely by Firecracker) also drops all-zero pages, which
  shrinks the 1 GiB base to ~50 MB. L1 keeps only the current base memory in tmpfs as a cache (the
sparse version, rebuilt from the packed copy);
  restore reads the chain back from the host. So L1's RAM no longer grows with steps, `rewind` and
  `vm up` work after `vm down`, `fork` clones the chain (APFS `clonefile`) into the new workdir and
  boots once there to fill its mirror, and `envgit gc` deletes snapshots no step builds on (the
  closure over `parent`, so a live diff keeps its ancestors).
- **Egress:** L2 has no network device, only loopback. Its agent runs an HTTP proxy port on
  `127.0.0.1:3128` that tunnels each connection over vsock — L2 → Firecracker's UDS on L1 → L1 → VZ
  vsock 3128 → envgit-vm → a unix socket envgit serves. During `envgit run` envgit starts srt's proxy
  there with the policy's allowlist and the same gate as on srt (§4), so `network.l7`, irreversible
  rules, prompts and the step's `net` effects all behave identically. Commands in L2 get a
  credential-free `HTTP(S)_PROXY=http://127.0.0.1:3128` and a CA bundle (`/etc/envgit/ca.pem`: the
  rootfs roots plus the workdir's proxy CA when TLS is terminated — one CA per workdir, generated once,
  key kept on the host). The proxy's token changes every step; the agent adds the current one to each
  connection's first request (and asks plain-HTTP requests for `Connection: close`), so long-lived
  processes such as the REPL worker keep working from step to step. Between steps nothing listens: a
  background process that tries to reach out gets an HTTP 503 whose body starts with `envgit:` (plain
  HTTP; for `https://` the client only reports a 503 to its CONNECT). A background process started in
  one step that reaches out during a later step gets through, and its requests are recorded on that
  later step. Starting and stopping the proxy adds ≈ 0.15 s to a step when the policy allows any host. Only proxy-aware clients get out — raw sockets and DNS have no route — which is the
  egress property, not a gap. Every exec also carries the host's wall clock, because a restored
  guest's clock is wherever its snapshot left it (TLS checks fail otherwise).
- **Protocol:** one framed protocol on both hops — a 4-byte length + JSON header, optionally followed
  by a byte stream (files, tar).
- **On Linux (arm64, x86_64), no nesting:** the same supervisor binary runs on the host as an ordinary
  process (host mode, chosen when it is not PID 1): `vm up` starts it detached with the paths as
  flags, after checking `/dev/kvm` is usable; it listens on the workdir's unix socket instead of
  vsock, writes snapshots straight to `.envgit/vm/snaps`, and joins L2's egress connections straight
  to envgit's proxy socket. Every Firecracker runs with a per-VM directory as its working directory
  and is configured with relative paths (`rootfs`, `layer` — symlinks to the images — and `v.sock`),
  because a snapshot records them: so the prebuilt base and any session's snapshots restore in any
  workdir, and several VMs on one host do not collide. L1 keeps its absolute paths (`/dev/vda`,
  `/tmp/v.sock`), so existing macOS snapshots still load. Firecracker gets `PR_SET_PDEATHSIG`, so a
  dead supervisor does not leave a guest behind. `build.sh` on Linux lays out `envgit-supervisor`
  and `fc/` instead of the Swift helper and L1, builds the Node layer with the host's `mksquashfs`
  (squashfs-tools), and makes its own prebuilt base. The egress proxy is srt's, so the host needs
  what srt needs on Linux: bubblewrap, socat and ripgrep. x86_64 has its own pins in `fetch.sh`
  (Firecracker, the CI kernel — pinned from a download, as its bucket publishes no checksum — the
  amd64 cloud image, Node, ripgrep). The guest side needs Go and cpio; `build.sh --guest-only x86_64 DIR`
  makes it on another machine (a Mac, cross-compiling) and `ENVGIT_VM_GUEST_DIR=DIR` builds without
  them. Checked on an i7-10700K under WSL2 (nested KVM): the full suite with the vm e2e tests passes
  (120, 16 skipped for Codex), `vm up` ≈ 1.1 s from the prebuilt base, a step ≈ 0.35–0.65 s.
  Tested on a Mac with `scripts/vm/linux-test.sh`, which boots a Linux VM from L1's kernel (it has
  KVM) with the same Ubuntu image and Node layer as root and this repo shared in, and runs the vm
  e2e tests there against a Linux layout (`build.sh --linux-layout`); all pass, egress and
  `envgit mcp` included (the script unpacks pinned noble bubblewrap, socat and ripgrep debs into
  that VM). The numbers from it are still nested — that VM is an L1 — so they say nothing about
  bare metal: `vm up` ≈ 1 s from the prebuilt base, `run true` ≈ 0.6 s, `rewind` ≈ 0.7 s, resume
  ≈ 0.9 s. On a real host the expectation is Firecracker's own: L2 boot in ≈ 125 ms and no nested
  fault costs.
- **Not portable:** Firecracker snapshots do not load on a different CPU model, so a snapshot taken on
  a Mac will not restore on a Linux server even though the backend code is the same.
- **Measured (M3 Pro):** new-session `vm up` ≈ 2 s from the prebuilt base (≈ 6 s with a cold boot: L2 boot ≈ 3.7 s + base snapshot + import); resuming
  after `vm down` ≈ 2 s; `envgit run true` ≈ 0.35 s end to end, its diff ≈ 2 MB; `rewind` on a live
  VM ≈ 0.75 s, on a stopped one ≈ 2 s (L1 boot included).
- **L2 overhead** (`scripts/vm/bench`, same Go binary on the host and in L2): CPU (sha256) +7 %,
  syscalls ≈ native, but memory is the cost. A first write to a page after a snapshot traps for
  dirty-page tracking, and under nesting that exit is expensive: faulting in 256 MB takes 1.3 s in L2
  vs 12 ms on the host (≈ 20 µs a page); with pages already written since the last snapshot it is
  83 ms. Never-touched guest RAM is worst: right after boot, faulting in 120 MB takes ≈ 7.8 s, almost
  all system time (≈ 250 µs a page), and reading the 123 MB `node` binary the first time costs the
  same (its page-cache pages are fresh RAM; the block device itself reads 40 MB in 36 ms, and
  decompression is a small share). The expensive hop is L2→L1, the nested stage-2 fault: L1 touching
  its own fresh memory costs ≈ 1.7 µs a page, so pre-touching L1 does not help. A guest restored from
  a snapshot pays less for the same 120 MB (≈ 1.6–2.5 s; its memory is file-backed in L1) — hence the
  prebuilt base; warming node during each session's own boot would only move the cost into `vm up`
  (6 s → 12.5 s, first node 11 s → 3 s). fork+exec is
  3.5× native after a snapshot and 1.6× warm. Writing files in `/work` runs at ≈ 40–80 MB/s. So
  steps that touch a lot of memory pay for it. That trap is the price of diffs holding only what a
  step wrote; Firecracker's mincore-based diffs avoid it but hold every resident page, so each step
  would persist the whole working set — a known cost, not a planned change.
- **REPL in L2:** `envgit mcp` on this backend installs envgit's worker (three compiled modules
  and acorn, versioned) under `/opt/envgit` and runs it as the agent's child; each `execute` is a step
  as on srt. The worker lives in guest memory, so a rewind brings its variables back to that step
  (the srt REPL can only reset). Its timeout is kept on the host and pauses while a person is asked
  to approve a request. `envgit mcp` keeps srt's proxy up between steps and opens only the tunnel.
- **Costs of nesting, measured:** from the prebuilt base, the first node in a session ≈ 1 s and the
  first `execute` (worker install included) ≈ 3.5 s, against ≈ 11 s and ≈ 16 s after a cold boot;
  a `fetch` in the REPL 1–4 s. Each step still pays the dirty-tracking trap for the pages it writes
  again, so even a warm `envgit run node -e 1` takes ≈ 1–1.5 s end to end.
- **Size cap:** `snapshot.maxBytes` (§3.5) applies here too. A step on the current branch can only go
  once nothing builds on it, so its diff is folded into each child first: both are sorted extent lists
  (`mem.idx`), merged with the child's pages winning (what `rebase-snap` does at restore), and the
  child's `meta.json` re-parented to the dropped step's parent; its machine state is unchanged. The
  folded copy replaces the child via a rename, and a crash in between is undone on the next gc or fold.

### 3.7 Timeline UI (`src/ui`)

`envgit ui [--port N] [--open]` serves the session timeline to a browser: a loopback HTTP server
and one self-contained page (no external resources) that polls every 1.5 s, so a running agent's
steps appear as they are recorded.
- **What it shows:** the session's steps as a tree (from each step's `parent`), the current branch
  highlighted and steps off it dimmed, HEAD marked; per step its command, exit code, timing,
  snapshot, Codex tool-call id, irreversible marker, and effects grouped by kind (files written and
  deleted, requests, policy denials — srt's sysctl / mach lookups folded away as noise, as `log`
  does). On srt it diffs the step's snapshot against its parent's (unified text diffs; binary, files
  over 1 MB and over 3000 lines are named, not diffed). vm snapshots are memory and disk images, so
  there the step's fs effects from the mirror sync stand in. Other sessions can be browsed read-only.
- **Rewind and fork** run the CLI itself (`envgit rewind|fork`), so the busy lock, the drift check
  and the vm boot behave as at a terminal; the CLI's message is shown as is. A rewind refused for
  edits made outside envgit offers `--force` as a second, separately labelled click.
- **Access:** the page can rewind, so the server binds 127.0.0.1, its URL carries a random token
  that every API call needs (POSTs in a header, so a plain link cannot mutate), and requests must
  name this host (no DNS rebinding). The step log is read leniently: a step still being appended is
  left for the next poll.

## 4. Irreversibility

Effects are classified at policy-compile time and confirmed at runtime by the proxy:

- **Reversible** — contained in the snapshot. Rewind restores fully.
- **Irreversible** — crossed the boundary. Gated (ask / deny) per policy; logged with a marker; rewind past one prints what cannot be undone.

The product promise is *audit + gate + in-sandbox rewind*, not a time machine.

**Gating on srt** (`src/core/policy/gate.ts`). srt already funnels all sandbox traffic through its
proxy; when the policy has request-level rules (`network.l7`, or an `irreversible` net rule) envgit
turns on srt's TLS termination — a per-run CA that srt makes trusted inside the sandbox through
`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO` and friends — and its
`filterRequest` hook, so every HTTP(S) request reaches the gate with method, canonical host and
normalized path (ambiguous spellings like `/a/../b` are refused). Checked with curl, Node `fetch`
(envgit sets `NODE_USE_ENV_PROXY=1`), Python `urllib` and git over HTTPS. Go (`gh`, GitHub's MCP
server) on macOS verifies through the system trust daemon, which the sandbox denies, unless
`SSL_CERT_FILE` is set; srt sets it only when it terminates TLS, so for opaque tunnels envgit points
it at `/etc/ssl/cert.pem` (roots added to the keychain are not in it). Checked with
github-mcp-server both ways.

- `network.l7` denies what it does not list for a host; then the first matching `irreversible` net
  rule applies its `action`: `allow` lets it out and marks the step, `deny` refuses it with a 403
  whose body says why (so the agent can tell policy from failure), `ask` (default) holds the request
  while a person decides. No answer, a decline, or a failing prompt all deny — the gate fails closed.
- Who is asked: `envgit run` prompts on `/dev/tty` (not stdin, which the command inherits; 2-minute
  timeout); `envgit mcp` asks the client through MCP elicitation when it supports it (Claude Code shows
  a dialog in interactive sessions); with neither, `ask` denies and the reason says how to allow the
  rule on purpose. A held request is a waiting HTTP call — most clients wait, some (npm) time out.
  The REPL's per-step timeout does not run out while a person is being asked.
- Each judged request is a `net` effect on the step with `irreversible: { rule, decision }`; a step
  where an irreversible request actually went out gets the step-level `irreversible` marker that
  `log` shows and `rewind` warns about.
- **Stock rules** (`- preset: default`, `src/core/policy/presets.ts`), expanded in place by the loader
  so the order stays visible and a rule written before the line overrides it; `envgit init` writes
  it, and a policy without the line has none. Net: `git push` over smart HTTP to any host
  (`POST /**/git-receive-pack`), npm `PUT`/`DELETE`, PyPI upload, crates.io publish/yank, container
  image pushes on any OCI registry (`PUT /v2/**/manifests/*`), GitHub REST writes (`/repos`, `/orgs`,
  `/user`, `/gists`, `/projects`, `/teams`) and GitLab REST writes. Shell: `git push`,
  `npm|pnpm|yarn npm publish`, `npm unpublish`, `cargo publish`, `twine upload`, `docker push`,
  `gh pr merge`, `gh release create`, `terraform apply|destroy`. Not covered: GraphQL mutations
  (`api.github.com/graphql` is a POST for reads too, so GitHub's MCP server would be asked on every
  read, and rules do not see bodies); `git push` over SSH and `docker push` (the daemon is outside the
  sandbox), which only the shell rules see. Cloud CLIs (`aws`, `gcloud`) are left to the policy's
  author: their writes are not one path pattern.
- Shell rules are judged the same way before the command starts (a denied one never runs). They see
  the command line and the simple commands of an `sh -c` script, so a variable or a subshell gets past
  them — the net rule is the enforcement, the shell rule is an early, readable stop.
- **Tunnels the gate cannot see into are refused** while request rules apply: srt's
  `refuseOpaqueTunnels` turns away a CONNECT that is not TLS (plain HTTP tunnelled with `curl -p`, or by
  Node's `fetch`, which CONNECTs for `http://` too), every SOCKS CONNECT, and SSH carried over the
  proxy; `requireHostMatch` answers 421 when a Host header or TLS server name names another host than
  the one connected to. Each refusal is a `policy` effect on the step (`deny http-request CONNECT …`).
  **Until this was added, a CONNECT carrying plain HTTP passed the gate unjudged on every srt path** —
  `envgit run`, `envgit mcp`, `envgit claude`, Codex — so an irreversible `http://` request could go out
  through a tunnel; HTTPS was always judged. Found while routing Codex's `http/request` through the
  gate (2026-10-27); covered by `gate.e2e` (`curl -p` POST refused, server not reached) since.
- `network.noInspect` lists hosts left undecrypted (certificate pinning, mTLS). With request rules
  such a host could only be an opaque tunnel, which the gate refuses, so envgit rejects a policy that
  combines the two and says which to drop. Without request rules nothing is decrypted or judged and
  `noInspect` changes nothing. On the vm backend the same proxy and gate serve L2 through a vsock
  tunnel (§3.6), during a step only.
- Known gap: with `requireHostMatch` on, a request to an IPv6-literal address is refused with 421 —
  srt compares the Host header's address without brackets against Node's `URL.hostname`, which keeps
  them (and normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`). Names and IPv4 are unaffected.

## 5. Milestones

1. **M0** — `envgit init` / policy file / `envgit run <cmd>` on the srt backend with an action log.
2. **M1** — REPL with persistent state and capability injection, exposed as an MCP server. Demo ([`demo-m1.md`](demo-m1.md)): 1.6× fewer context tokens on a 48 KB task, 9.4× (3.8× cost) on a 380 KB task where per-capability tools hit Claude Code's result-size limit and got the answer wrong.
3. **M2** — per-step snapshots; `envgit log`, `envgit fork <step>`, `envgit rewind <step>`. Done first on srt with fs-level snapshots (below), because Firecracker needs Linux + KVM; the Firecracker backend moves to M2.5.
   - **M2.5** — Firecracker backend (Linux + KVM): full memory + disk snapshots behind the same `log` / `fork` / `rewind`.
4. **M3** — irreversible-action gating through the egress proxy (done on srt, §4); Codex environment adapter, Claude Code and Copilot CLI through hooks (§3.4).
5. **M4** — web UI timeline (`envgit ui`, §3.7). The Apple Virtualization backend it also listed became the vm backend's L1 on macOS (§3.6) rather than a backend of its own.

6. **M5** — close the enforcement gap and generalize the REPL (from the 2026-10-27 review, §7).
   - **One enforcement level for every agent.** Done for Claude Code (whole process in srt), Codex (`http/request` through the gate), and `envgit run` (fs effects from the snapshot diff); on the way, opaque tunnels are now refused (§4). Plan as written: `envgit claude` runs the whole `claude` process under envgit's srt with the gate (sandbox-runtime supports wrapping a process: its Bash, hooks and MCP servers all go through the proxy), with Claude Code's own sandbox off to avoid nesting; Codex's `http/request` is forwarded through the proxy instead of around the gate; `envgit run` on srt records fs effects by diffing the step's snapshot against its parent, as the hooks already do. Acceptance: with one policy, a `git push` to GitHub from Claude Code, Codex and `envgit run` is each stopped at the HTTPS request, not by command-line matching. Accepted 2026-10-28: one policy with only the net rule (`POST /**/git-receive-pack`, deny), a real `git push` to github.com (to `refs/pull/1/head`, which GitHub refuses to update anyway) from `envgit run` (hidden as `$g push`), a real Claude Code session and a real Codex session; each was refused at the request, recorded on its step as a denied `net` effect, and the remote never changed. On the way, `envgit claude` now hooks `PostToolUseFailure`: a failed Bash call (the refused push) was landing on the turn's checkpoint instead of its own step.
   - **Generic MCP → REPL bridge.** Done for stdio servers (§3.3): the hardcoded `github` capability is gone. Accepted: GitHub's MCP server (v2.0.3) runs in the sandbox, and the M1 demo rerun against it gave 1.6× fewer context tokens and 2.4× lower cost, both arms 3/3 correct ([`demo-m1.md`](demo-m1.md#m5-rerun-githubs-mcp-server)). Plan as written: any MCP server's tools become typed async functions (`await <server>.<tool>(args)`), declarations generated from their JSON Schema; the hardcoded `github` capability goes away. Acceptance: the GitHub MCP server connected, and the M1 demo rerun against it (tools vs. `execute`), not against envgit's own tools.
   - **Keep large results in the sandbox by default.** Done (§3.3): handles for arrays and objects over 4,000 characters, output cut at 40,000, `sample`/`schema`/`assert`. Rerun ([`demo-m1.md`](demo-m1.md#m5-rerun-results-kept-in-the-sandbox)): no run returned a large array or object, so handles never fired; the cut kept the large corpus's habit of printing every file in check (3 requests instead of 7, 3/3); on the grown `src` corpus `execute` was 19× smaller and 10× cheaper but 0/3, its regex taking a `require('node:…')` inside a template string for an import that the tools arm, reading every file, did not. Plan as written: the M1 demo showed the model printing raw data to check its own code, giving back the saving. Three changes: `execute` returns a large result as a handle (`$1: Issue[] (200)`) rather than serializing it, like Jupyter's `Out[n]`; output over a threshold is truncated in the REPL with head, tail and a line saying how to look at a slice; `sample()`, `assert()` and `schema()` are injected so the model can spot-check instead of reading everything. Rerun the demo afterwards to see whether the M1 ratio was the method's ceiling or the model's floor.
   - **CI, x86_64, release.** A GitHub Actions workflow running the Linux srt suite (`.github/workflows/test.yml`: Ubuntu 24.04 x86_64, AppArmor's user-namespace restriction lifted for bubblewrap; green on GitHub since 575b3e5, 104 passed and 32 skipped as on the x86_64 desktop; vm tests need KVM and stay manual); x86_64 pins for Firecracker, kernel, image and Node (done, checked on an x86_64 desktop, §3.6); `npm publish` of 0.1.0 as `agent-envgit` (npm refused `envgit` as too close to `env-git`; the command is still `envgit`; package: `dist` without source maps, the default policy, the vm build scripts and guest sources; checked by installing the packed tarball); a default `policy.yaml` that ships rules for the common irreversible commands, so nobody has to know `git-receive-pack` — done: `- preset: default` (§4), checked against a real `git push` to a local smart-HTTP remote, stopped at the request even when the command line hides it.
7. **M7 — 0.2: keep the first users** (does M6's number but runs before it; see §7.1). 0.1.0 is on npm; what decides the project now is whether the first fifty people who try it get past the install and come back with a question rather than a dead end.
   - **`envgit doctor`.** One command that checks everything a sandbox tool breaks on: Node ≥ 22, bubblewrap / socat / ripgrep and their versions on Linux, AppArmor's `kernel.apparmor_restrict_unprivileged_userns` on Ubuntu 24.04+, ripgrep on macOS, Claude Code and Codex versions against the ones tested, KVM for the vm backend — each with the fix. Most issues against a sandbox are environment issues.
   - **The preset's three holes** (`presets.ts` names them): `git push` over SSH, stopped at srt's SOCKS layer on `*:22` with a `deniedDomainReasons` text the ssh client prints; `docker push`, by keeping the docker socket out of the sandbox by default and marking any `allowUnixSockets` entry for it irreversible; GraphQL mutations, by letting a net rule match the request body (`body: { contains: "mutation" }`), which TLS termination already exposes.
   - **`envgit show <step>` and `envgit diff <a> <b>` on the CLI.** The diff exists only in the UI; scripts and CI need it as text.
   - **`envgit export <session>` / `import`.** A tar of `steps.jsonl` plus the snapshots it refers to, so a session can be sent along with a bug report or a demo and rewound on another machine.
   - **Data in, data out, per REPL step.** For each `execute`, record how many bytes the capabilities read into the sandbox and how many came back to the model; `log` and the UI flag an extreme ratio. This is the audit signal for the M5 rerun's 0/3 (§5 M5, demo-m1): the model concluded without looking, and nothing in the record showed it. It does not fix the model's judgement — envgit cannot, and should not try — it makes the gap visible.
   - **`envgit demo`.** A thirty-second run in a temporary directory with a scripted stand-in for an agent: five steps, a push refused at the request on the fourth, a rewind. No API key, no agent installed. The README gets a GIF of it.
   - **Release 0.2.0** with the README's `npx` form corrected (`npx -p agent-envgit envgit init`) and a line on why the package is `agent-envgit` while the command is `envgit`.
8. **M6 — GUI agents.** The VM gets a display (Xvfb, a window manager, `xdotool`/`ydotool`, AT-SPI, VNC/WebRTC), GUI actions are steps, and clicks are resolved through the accessibility tree before injection so `irreversible.gui` rules can gate a Send / Pay / Confirm. Not before 0.2 and its first users: whether anyone asks for this decides when, or whether, it is built (§7.1).

## 7. Review, 2026-10-27

After M0–M4. Verified on Linux: `npm ci`, build, the full srt suite (77 tests, TLS-terminating gate included), the README quick start by hand, `.envgit` read-only inside the sandbox. The VM backend was not run (needs the Mac build).

What holds: the layering (srt is the boundary, `node:vm` only persists, the gate sits on srt's `filterRequest`); the Codex adapter as a real exec-server rather than hooks, which is why Codex alone gets request-level gating; the nested-VM costs being measured and answered with the prebuilt base; the M1 demo reporting its own unfavourable runs.

What does not, in priority order:
1. `envgit run` on srt records no fs effects (a `sed -i` step shows `effects: []`); only the hooks path diffs snapshots.
2. Under Claude Code and Copilot there is recording but no enforcement: only shell rules apply there, and `g=git; $g push` gets past them. The README's "in every case … refused before it runs" overstates this.
3. The REPL's capabilities are hardcoded (`fs`, `http`, two GitHub calls); the MCP-tools-as-functions design is not implemented, so the M1 demo compares envgit's own tools with themselves. (Bridge done in M5; demo rerun against GitHub's MCP server: 1.6× context, 2.4× cost.)
4. Codex's `http/request` bypasses the gate.
5. The nested VM on macOS is a demo tier (a warm step ≈ 1–1.5 s against tens of ms on srt); the production shape is bare Firecracker on Linux (arm64 and, since M5, x86_64). The nested fault cost is hardware, not something to optimize further.
6. No CI; `lint` script without eslint.
7. Default policy needs a stock set of irreversible rules (done in M5: `preset: default`); generated files with machine paths (`demo/results`, `.github/hooks/envgit.json`) must stay out of commits.

M5 above is the answer to 1–4 and 6–7; M6 is where GUI work starts.

### 7.1 Review, 2026-10-28, after M5

Verified on Linux from a clean `npm ci`: 104 tests pass (the vm suite needs KVM and was not run); `agent-envgit@0.1.0` installed from npm, `envgit init` writes `- preset: default`, and a push hidden as `$g push` is refused. M5's four items are accepted on their own criteria, each against the real thing: Claude Code and Codex sessions with a real GitHub remote, GitHub's MCP server in the sandbox, CI green on GitHub, x86_64 on a real machine.

Two findings worth more than the checklist:
- **The demo rerun's answer to "ceiling or floor" is: the model.** On `src`, `execute` was 10× cheaper and 0/3, from a regex that took a `require('node:http')` in a template string for an import; `tools`, forced to read every file, was right. The conclusion written in demo-m1 — keeping data out of the context also keeps out the context a judgement needs — is the most useful sentence in the project. The REPL is to be presented as *controllable* (what stays in the sandbox and what reaches the model is decided by policy and recorded), not as *cheaper*. The 0/3 is not a bug to fix in envgit; M7's data-in / data-out signal is what envgit can do about it.
- **The preset names its own holes** (SSH push, docker push, GraphQL mutations). They are common paths and are M7's second item.

Order: M7 before M6. The numbering is the order the plans were written in, not the order of work. 0.1 just shipped and what is scarce is feedback, not features; M7 lowers the cost of trying and reporting, and ships in weeks; M6 is a month of work for a user group that is still small. Whether M6 follows 0.2 depends on who asks for it.

## 8. Prior art

- anthropics/sandbox-runtime — OS-primitive sandbox + proxy, credential masking.
- NVIDIA/OpenShell — container/microVM runtime with gateway, L7 egress policy.
- Cloudflare Code Mode, Anthropic programmatic tool calling — tools as code APIs.
- E2B / Daytona / Fly Sprites / Modal — hosted sandboxes with pause/resume.
- Remount — resumable agent sessions on your own infra.

None combine per-step snapshots, fork/rewind, an action log and irreversibility gating.
