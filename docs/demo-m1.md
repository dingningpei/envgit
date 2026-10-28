# M1 demo: one tool per capability vs. `execute`

Design §5 promised "same task, 10× fewer tokens" for M1. This is what was measured.

## Setup

Both arms use envgit's own MCP server, the same sandbox (srt), the same policy (`fs: true` only) and
the same model; only the tool shape differs:

- **tools** — `envgit mcp --tools`: `readFile`, `writeFile`, `readdir` as separate MCP tools, the way
  agents usually get tools today.
- **execute** — `envgit mcp`: one `execute` tool that runs JavaScript in the persistent REPL with `fs`
  injected.

Harness: `claude -p` (Claude Code headless, the user's login), `--model claude-opus-5-5`, all built-in
tools off (`--tools ""`), `--strict-mcp-config`, `--setting-sources ""`. Script: [`scripts/demo.mjs`](../scripts/demo.mjs).

```bash
npm run demo                                                      # small corpus, 2 arms × 3
DEMO_CORPUS=srt-dts DEMO_ARMS=tools DEMO_REPEATS=1 node scripts/demo.mjs
DEMO_CORPUS=srt-dts DEMO_ARMS=execute DEMO_REPEATS=3 node scripts/demo.mjs
```

Task (same text in both arms; `<dir>`/`<ext>` per corpus):

> Using only the envgit tools, inspect every `<ext>` file under `<dir>/` (recursively). For each file
> report the builtin modules it imports through a "node:" specifier (ignore imports without that
> prefix) and the names it exports (top-level `export function|async function|class|const|let|interface|type`
> declarations). Reply with ONLY a JSON array … sorted by file …

Answers are checked against a regex ground truth (`demo/results/*-ground-truth.json`); a wrong answer
is counted as wrong, not dropped.

| Corpus | Files | Size |
|---|---|---|
| `src` — envgit's own sources | 12 | ~48 KB |
| `srt-dts` — `@anthropic-ai/sandbox-runtime` `dist/sandbox/*.d.ts` | 38 | ~380 KB |

## Results (medians)

| Corpus | Arm | Runs | Correct | Requests | Tool calls | Context tokens¹ | Output tokens | Cost |
|---|---|---|---|---|---|---|---|---|
| src | tools | 3 | 3/3 | 5 | 21 | 37,044 | 2,733 | $0.211 |
| src | execute | 3 | 3/3 | 2 | 1 | 23,267 | 1,207 | $0.170 |
| srt-dts | tools | 1 | **0/1** | 9 | 42 | 556,350 | 17,312 | $1.231 |
| srt-dts | execute | 3 | 3/3 | 7 | 6 | 59,358 | 9,145 | $0.326 |

¹ Σ over requests of input + cache-write + cache-read tokens, i.e. everything the model read. The
fixed first-request overhead (Claude Code's system prompt + tool list) is ~3.8k in both arms.

**Ratios:** small corpus 1.6× fewer context tokens, 19% cheaper. Large corpus 9.4× fewer context
tokens, 3.8× cheaper — and only `execute` got the right answer.

## What drives the ratio

The saving is roughly *corpus size × sequential round trips × fraction of raw data that stays in the
sandbox*. Each run exposed one of these:

- **Small corpus, little to save.** 12 files ≈ 9k tokens; Claude Code issues parallel tool calls, so
  the tools arm finished in 5 requests and history never ballooned.
- **The model often prints the raw data anyway.** In 2 of 3 small-corpus `execute` runs the model
  computed the answer in code *and* printed every file to check its regexes, returning as much text as
  the tools arm. The one run that trusted its code used 11k context tokens and cost $0.075 (2.8×
  cheaper than tools). No prompt nudge was added to discourage printing; that would measure the nudge.
- **Large results hit harness limits.** Two `.d.ts` files are ~65k characters, over Claude Code's
  per-tool-result limit; the result is replaced by a "saved to file" notice. The tools arm has no way
  to read that file, so it reported those files' exports as empty — both tools runs (including a
  probe on an earlier wording) failed this way. `execute` runs hit the same limit when printing, then
  recovered by computing the answer inside the sandbox.
- **Prompt caching narrows the cost gap.** Most of the tools arm's context is its own history re-read
  on every request: on the large corpus 457k of its 556k context tokens were cache reads, billed at a
  small fraction of the input price. So cost falls less than context (3.8× vs 9.4×). Output tokens
  point the other way: `execute` wrote fewer (≈9k vs. 17k).

## Caveats

- Measured under Claude Code's harness, not a minimal agent loop; with a smaller fixed overhead the
  ratios would be larger.
- The large-corpus tools arm has n=1 ($1.23 per run); a probe run on an earlier wording of the task
  used 107k context tokens over 3 requests, so its context usage varies a lot between runs.
- Small-corpus runs used the task text before the "ignore imports without that prefix" clause was
  added; every import in `src/` uses `node:`, so the answer is the same.
- Five earlier runs with an ambiguous spec (`node:fs/promises` → `fs` or `fs/promises`?) and a bug in
  output-token accounting were discarded; raw transcripts are kept locally only (`demo/results/*.jsonl`
  is git-ignored).

## M5 rerun: GitHub's MCP server

The runs above compare envgit's own tools with themselves. With the generic bridge (design §3.3),
the same two arms run against [GitHub's MCP server](https://github.com/github/github-mcp-server)
v2.0.3 (`stdio --read-only`, release checksum verified) inside envgit's sandbox: **tools** gets its
`list_issues` and `issue_read` as MCP tools with the server's own schemas (`envgit mcp --tools`),
**execute** gets them as `github.list_issues(…)` in the REPL with generated declarations.

```bash
GITHUB_TOKEN=… DEMO_GITHUB_MCP=/path/to/github-mcp-server DEMO_CORPUS=github node scripts/demo.mjs
```

Task: of the first 150 issues (not PRs) ever opened in `modelcontextprotocol/typescript-sdk`, how
many are closed, how many carry each label, and the 5 most commented. Ground truth is taken from
GitHub's REST API at the start of the run (`demo/results/github-ground-truth.json`).

| Arm | Runs | Correct | Requests | Tool calls | Tool result chars | Context tokens | Output tokens | Cost |
|---|---|---|---|---|---|---|---|---|
| tools | 3 | 3/3 | 3 | 2 | 18,410 | 28,777 | 2,222 | $0.136 |
| execute | 3 | 3/3 | 3 | 2 | 1,755 | 17,479 | 841 | $0.056 |

**Ratios (medians):** 1.6× fewer context tokens, 2.6× fewer output tokens, 2.4× cheaper; both arms
always right.

- **The server already trims.** `list_issues` takes a `fields` list, and every run in both arms asked
  only for number, state, labels and comments, so the tools arm read 18k characters, not the full
  issue bodies. The saving here is what is left after the server's own filtering: the tools arm
  still had to read every issue and count in its head (its output tokens are the counting).
- **`execute` paged and counted in code** and returned the aggregate. One run spent two extra calls
  checking the ordering (`created_at` monotone, no PRs), which took its context to 28.7k, level with
  the tools arm, at less than half the cost.
- The same task at 1,500 issues would need 15 pages; the tools arm's history grows with every page,
  `execute`'s does not.

## M5 rerun: results kept in the sandbox

After the M1 runs the REPL changed (design §3.3): a returned array or object over 4,000 characters
stays in the sandbox as `$1` and comes back as its type, output over 40,000 characters is cut in the
middle, and `sample()`, `schema()` and `assert()` are injected. The tools arm is unchanged (its
results come back whole), so only `execute` was rerun, except on `src`, which has grown from 12 files
(~48 KB) to 37 (~290 KB) since M1 and needed a new tools baseline. The `*-summary.json` files for
`src` and `srt-dts` now hold these runs.

| Corpus | Arm | Runs | Correct | Requests | Tool calls | Context tokens | Output tokens | Cost |
|---|---|---|---|---|---|---|---|---|
| src (37 files) | tools | 3 | 3/3 | 8 | 50 | 362,311 | 10,156 | $1.305 |
| src (37 files) | execute | 3 | **0/3** | 3 | 2 | 18,721 | 3,449 | $0.131 |
| srt-dts | execute (M1) | 3 | 3/3 | 7 | 6 | 59,358 | 9,145 | $0.326 |
| srt-dts | execute | 3 | 3/3 | 3 | 2 | 48,896 | 7,399 | $0.324 |
| github | tools (above) | 3 | 3/3 | 3 | 2 | 28,777 | 2,222 | $0.136 |
| github | execute | 3 | 3/3 | 3 | 2 | 17,718 | 856 | $0.054 |

- **`src`: 19× less context, 10× cheaper, and wrong every time.** All three `execute` runs listed
  `http` as a builtin of `src/adapters/codex/runners.ts`, whose only `node:http` is a
  `require('node:http')` inside a template string (a helper script it ships to the guest). Each run
  wrote a regex that also matched `require(…)`, printed the lines its regex treated specially, saw
  that one, and kept it, without reading the file around it. The tools arm read all 37 files whole
  and got it right, at ten times the price. Keeping data out of the context also keeps out the context
  a judgement needs; `assert` and `sample` don't help when the code's rule is the mistake.
- **`srt-dts`: the model still printed every file**, to check its regexes, as in M1; the 40,000 cut
  is what kept that from reaching Claude Code's result limit, and it answered from its code, right
  every time, in 3 requests instead of 7. Context fell 18%; cost stayed the same.
- **`github`: unchanged.** These runs already returned only the aggregate. They are where the
  helpers were used: every run called `schema()` on the first page, and two used `assert()`.
- **Handles were never created.** No run returned a large array or object; the models print or
  return strings. An earlier rerun, where a returned *string* also became a handle, cost three runs an
  extra round trip to `print($1)` their own answer, and a 20,000-character cut clipped a ~20k answer;
  both were changed (strings print, the cut is 40,000) before these runs.

So the answer to M1's question, *ceiling or floor*: on this model the method's saving is limited
less by the REPL than by what the model chooses to look at. When it prints raw data to check its code,
the cut caps the cost; when it doesn't look, it can be confidently wrong where the tools arm, which
must read everything, is not.
