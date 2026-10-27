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
irreversible:            # gated (§4): ask (default) / deny / allow, always logged red
  - net: { host: "github.com", method: POST, path: "/**/git-receive-pack" }   # git push
  - net: { host: "registry.npmjs.org", method: PUT }                          # npm publish
    action: deny
  - shell: ["git push", "npm publish"]
```

Compiles to: srt settings, Codex `config.toml` sandbox section, Copilot sandbox settings, and the REPL's injected globals. Enforcement is at the **effect** layer (syscalls, proxy), never by parsing agent code.

### 3.3 REPL (`src/repl`)

- `node:vm` context in a long-lived worker process that runs under the env backend (srt in M1); the backend is the security boundary, `node:vm` only provides persistence. Persistent across steps (variables survive). The engine sits behind an `Engine` interface so QuickJS / isolated-vm can slot in where an in-process boundary is wanted.
- Tools (MCP, CLI, HTTP) injected as typed async functions per `capabilities`.
- Only `print()` / return value goes back to the model; everything else stays in the sandbox.
- Each `execute` is one Step → one snapshot. On the vm backend the worker runs inside the guest and
  is part of that snapshot, so `rewind` restores REPL variables too (§3.6); on srt it resets them.
- Effects for a REPL step are recorded by the injected capability wrappers (files read/written, hosts contacted, denials), since the macOS sandbox violation log drops events for long-lived processes; the backend's violation log is a best-effort supplement.
- No shell-string API by default; typed command capabilities instead.

### 3.4 Adapters (`src/adapters`)

- `claude-code`, `codex`, `copilot`: translate policy to native config; expose envgit as a remote/self-hosted environment where the vendor protocol allows (Codex `exec-server --remote` first).
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

### 3.6 VM backend on macOS: nested Firecracker (`src/core/env/vm.ts`, `vm/`)

Memory + process + file snapshots, from the spike in [`spike-nested-firecracker.md`](spike-nested-firecracker.md).

```
envgit (TS) ──unix socket── envgit-vm (Swift, Virtualization.framework) ──vsock── L1 supervisor (Go /init)
                                                                                     │ Firecracker API + vsock
                                                                                     └── L2 agent (Go /init) → chroot into the CI rootfs
```

- **Lifetime:** `envgit vm up` boots L1 and either resumes the current vm session at its head (from
  the snapshots on the host) or, with no such session or `--new`, boots a fresh L2 and imports the
  workdir; `envgit vm down` stops both and loses nothing. `rewind` boots the VM itself if it is down.
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
  on two read-only squashfs layers — Node 24 (`/usr/local`) over the Ubuntu 24.04 server cloud image
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
- **Not yet:** a cap on the disk the snapshots take besides `envgit gc`.

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
(envgit sets `NODE_USE_ENV_PROXY=1`), Python `urllib` and git over HTTPS.

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
- Shell rules are judged the same way before the command starts (a denied one never runs). They only
  see the command line envgit was given, so `sh -c 'git push'` gets past them — the net rule is the
  enforcement, the shell rule is an early, readable stop.
- `network.noInspect` lists hosts left as opaque tunnels (certificate pinning, mTLS); request rules
  cannot see their HTTPS traffic. On the vm backend the same proxy and gate serve L2 through a vsock
  tunnel (§3.6), during a step only.

## 5. Milestones

1. **M0** — `envgit init` / policy file / `envgit run <cmd>` on the srt backend with an action log.
2. **M1** — REPL with persistent state and capability injection, exposed as an MCP server. Demo ([`demo-m1.md`](demo-m1.md)): 1.6× fewer context tokens on a 48 KB task, 9.4× (3.8× cost) on a 380 KB task where per-capability tools hit Claude Code's result-size limit and got the answer wrong.
3. **M2** — per-step snapshots; `envgit log`, `envgit fork <step>`, `envgit rewind <step>`. Done first on srt with fs-level snapshots (below), because Firecracker needs Linux + KVM; the Firecracker backend moves to M2.5.
   - **M2.5** — Firecracker backend (Linux + KVM): full memory + disk snapshots behind the same `log` / `fork` / `rewind`.
4. **M3** — irreversible-action gating through the egress proxy (done on srt, §4); Codex self-hosted environment adapter.
5. **M4** — Apple Virtualization backend; web UI timeline.

## 6. Prior art

- anthropics/sandbox-runtime — OS-primitive sandbox + proxy, credential masking.
- NVIDIA/OpenShell — container/microVM runtime with gateway, L7 egress policy.
- Cloudflare Code Mode, Anthropic programmatic tool calling — tools as code APIs.
- E2B / Daytona / Fly Sprites / Modal — hosted sandboxes with pause/resume.
- Remount — resumable agent sessions on your own infra.

None combine per-step snapshots, fork/rewind, an action log and irreversibility gating.
