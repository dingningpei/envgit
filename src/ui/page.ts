/** The timeline page served by `envgit ui`: one self-contained document, no external resources. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>envgit timeline</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e3e2dc;
  --accent: #2f5bd3; --accent-soft: #e6ecfb; --ok: #1f7a4a; --bad: #b42318; --bad-soft: #fdecea;
  --warn: #9a5b00; --warn-soft: #fff4e0; --add: #e7f6ec; --del: #fdecea; --code: #f2f1ec;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --panel: #1c1c1a; --ink: #ecebe6; --muted: #9a9993; --line: #2e2d2a;
    --accent: #8aa8ff; --accent-soft: #1f2a48; --ok: #6fcf97; --bad: #ff8a80; --bad-soft: #3a1d1b;
    --warn: #f2b45a; --warn-soft: #3a2c14; --add: #173322; --del: #3a1d1b; --code: #232321;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
header h1 { font-size: 15px; margin: 0; letter-spacing: .2px; }
header .wd { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
header select { font: inherit; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); max-width: 100%; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--code); color: var(--muted); white-space: nowrap; }
.pill.live { background: var(--warn-soft); color: var(--warn); }
.spacer { flex: 1; }
main { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr); gap: 0; min-height: calc(100vh - 53px); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } #detail { border-left: 0; border-top: 1px solid var(--line); } }
#timeline { padding: 12px 8px 40px 12px; overflow: auto; }
#detail { border-left: 1px solid var(--line); background: var(--panel); padding: 16px; overflow: auto; }
.empty { color: var(--muted); padding: 24px 8px; }
.row { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; padding: 6px 8px 6px 0; border-radius: 8px; cursor: pointer; }
.row:hover { background: var(--code); }
.row.sel { background: var(--accent-soft); }
.row.off { opacity: .55; }
.rail { display: flex; align-items: stretch; align-self: stretch; }
.rail i { width: 18px; position: relative; }
.rail i.dot::before { content: ""; position: absolute; left: 4px; top: 7px; width: 9px; height: 9px; border-radius: 50%; background: var(--panel); border: 2px solid var(--accent); }
.rail i.dot.head::before { background: var(--accent); }
.rail i.dot.bad::before { border-color: var(--bad); }
.rail i.line::after, .rail i.dot::after { content: ""; position: absolute; left: 8px; top: 0; bottom: -6px; width: 2px; background: var(--line); z-index: -1; }
.body { min-width: 0; }
.top { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.idx { color: var(--muted); font-variant-numeric: tabular-nums; }
.type { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; padding: 0 6px; border-radius: 4px; background: var(--code); color: var(--muted); }
.type.fs { background: var(--accent-soft); color: var(--accent); }
.type.checkpoint { background: var(--warn-soft); color: var(--warn); }
.sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; color: var(--ink); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.chip { font-size: 11.5px; color: var(--muted); }
.chip.bad { color: var(--bad); }
.chip.warn { color: var(--warn); font-weight: 600; }
.headtag { font-size: 11px; font-weight: 700; color: var(--accent); }
h2 { font-size: 16px; margin: 0 0 4px; }
h3 { font-size: 13px; margin: 18px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
pre.cmd { background: var(--code); padding: 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; margin: 8px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 8px 0; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.banner { padding: 8px 10px; border-radius: 8px; margin: 8px 0; }
.banner.bad { background: var(--bad-soft); color: var(--bad); }
.banner.warn { background: var(--warn-soft); color: var(--warn); }
.banner.ok { background: var(--add); color: var(--ok); }
details { border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; }
details summary { cursor: pointer; padding: 6px 10px; }
details ul { margin: 0; padding: 4px 10px 8px 28px; max-height: 260px; overflow: auto; }
details li { overflow-wrap: anywhere; }
.file { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; overflow: hidden; }
.file .fh { padding: 6px 10px; background: var(--code); display: flex; gap: 8px; align-items: baseline; }
.file .st { font-size: 11px; text-transform: uppercase; }
.st.added { color: var(--ok); } .st.deleted { color: var(--bad); } .st.modified { color: var(--warn); }
.hunk { margin: 0; padding: 4px 0; overflow-x: auto; }
.hunk div { white-space: pre; padding: 0 10px; }
.hunk .hh { color: var(--muted); }
.hunk .a { background: var(--add); } .hunk .d { background: var(--del); }
.note { color: var(--muted); padding: 6px 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { border-color: var(--bad); color: var(--bad); }
button:disabled { opacity: .5; cursor: progress; }
input[type=text] { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); min-width: 0; flex: 1; }
.muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>envgit</h1>
  <span class="wd mono" id="wd"></span>
  <span class="spacer"></span>
  <span id="busy"></span>
  <select id="session" aria-label="Session"></select>
</header>
<main>
  <section id="timeline" aria-label="Steps"></section>
  <section id="detail" aria-label="Step details"><p class="empty">Select a step.</p></section>
</main>
<script>
const API = location.pathname.replace(/\\/$/, '') + '/api/'
const TOKEN = location.pathname.split('/')[1]
let S = null, selected = null, chosenSession = null, inFlight = false, lastKey = ''
// The last rewind/fork result, kept across re-renders of that step's panel.
let flash = null

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k))
  return e
}
const short = id => (id ? id.slice(0, 8) : '--------')
const time = iso => (iso ? new Date(iso).toLocaleTimeString() : '')
const label = t => ({ checkpoint: 'ckpt' })[t] || t
// As envgit log: file and network denials (and envgit's own refusals) matter; sysctl/mach lookups are noise.
const relevant = e => e.kind === 'policy' && (/\\b(file|network)-\\S+\\s+\\S/.test(e.reason) || /^envgit: /.test(e.reason))

function summary(st) {
  try {
    if (st.action.type === 'exec') return JSON.parse(st.action.input).join(' ').replace(/\\s+/g, ' ')
    if (st.action.type === 'fs') return JSON.parse(st.action.input).map(o => o.op + ' ' + o.path).join(', ')
    if (st.action.type === 'push') return 'push ' + JSON.parse(st.action.input).join(' ')
  } catch {}
  return st.action.input.replace(/\\s+/g, ' ')
}

function counts(st) {
  const c = { write: 0, del: 0, net: 0, netDenied: 0, policy: 0 }
  for (const e of st.effects || []) {
    if (e.kind === 'fs' && e.op === 'write') c.write++
    if (e.kind === 'fs' && e.op === 'delete') c.del++
    if (e.kind === 'net') e.denied ? c.netDenied++ : c.net++
    if (relevant(e)) c.policy++
  }
  return c
}

async function load() {
  try {
    const q = chosenSession ? '?session=' + encodeURIComponent(chosenSession) : ''
    const r = await fetch(API + 'state' + q)
    const next = await r.json()
    const key = JSON.stringify(next)
    if (key === lastKey) return
    lastKey = key
    S = next
    render()
  } catch (e) {
    document.getElementById('busy').replaceChildren(el('span', { class: 'pill' }, 'disconnected'))
  }
}

function render() {
  document.getElementById('wd').textContent = S.workdir
  document.getElementById('busy').replaceChildren(S.busy ? el('span', { class: 'pill live' }, 'step running (pid ' + S.busy + ')') : '')
  const sel = document.getElementById('session')
  sel.replaceChildren(...S.sessions.slice().reverse().map(s =>
    el('option', { value: s.id, selected: S.session && s.id === S.session.meta.id }, s.id + ' · ' + s.backend + ' · ' + s.steps + ' steps' + (s.id === S.current ? ' (current)' : ''))))
  const tl = document.getElementById('timeline')
  if (!S.session) { tl.replaceChildren(el('p', { class: 'empty' }, 'No session yet: run a step (envgit run, envgit mcp, envgit codex).')); return }
  const { steps, head, chain, meta } = S.session
  const onChain = new Set(chain)
  const pruned = new Set(S.session.pruned || [])
  const kids = new Map()
  for (const st of steps) {
    const p = st.parent === undefined ? 'base' : st.parent
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p).push(st)
  }
  const rows = []
  rows.push(baseRow(meta, head))
  // Depth-first: the child on the active chain continues the column, other children branch off it.
  const walk = (key, depth) => {
    const cs = (kids.get(key) || []).slice().sort((a, b) => (onChain.has(b.index) - onChain.has(a.index)) || a.index - b.index)
    cs.forEach((st, i) => {
      const d = i === 0 ? depth : depth + 1
      rows.push(stepRow(st, d, onChain.has(st.index), st.index === head, pruned.has(st.index)))
      walk(st.index, d)
    })
  }
  walk('base', 0)
  const isCurrent = meta.id === S.current
  tl.replaceChildren(
    isCurrent ? '' : el('div', { class: 'banner warn' }, 'Not the current session: read only. Rewind and fork act on the current one.'),
    ...rows,
    el('p', { class: 'muted' }, steps.length - chain.length ? (steps.length - chain.length) + ' step(s) off the current branch (dimmed).' : ''),
  )
  if (selected !== null && selected !== 'base' && !steps[selected]) selected = null
  if (selected === null && steps.length) selected = typeof head === 'number' ? head : steps.length - 1
  showDetail()
}

function rail(depth, cls) {
  const r = el('span', { class: 'rail' })
  for (let i = 0; i < depth; i++) r.append(el('i', { class: 'line' }))
  r.append(el('i', { class: 'dot ' + cls }))
  return r
}

function baseRow(meta, head) {
  return el('div', { class: 'row' + (selected === 'base' ? ' sel' : ''), onclick: () => { if (selected !== 'base') flash = null; selected = 'base'; render() } },
    rail(0, head === 'base' ? 'head' : ''),
    el('div', { class: 'body' },
      el('div', { class: 'top' }, el('span', { class: 'type' }, 'base'), el('span', { class: 'mono muted' }, short(meta.base)),
        head === 'base' ? el('span', { class: 'headtag' }, 'HEAD') : '',
        meta.forkedFrom ? el('span', { class: 'muted' }, 'forked from ' + meta.forkedFrom.session + ' step ' + meta.forkedFrom.step) : ''),
      el('span', { class: 'sum muted' }, 'the workdir before the first step')))
}

function stepRow(st, depth, on, isHead, isPruned) {
  const c = counts(st)
  const chips = []
  if (isPruned) chips.push(el('span', { class: 'chip' }, 'pruned'))
  if (st.exitCode !== 0) chips.push(el('span', { class: 'chip bad' }, 'exit ' + st.exitCode))
  if (c.write || c.del) chips.push(el('span', { class: 'chip' }, (c.write + c.del) + ' file' + (c.write + c.del > 1 ? 's' : '')))
  if (c.net) chips.push(el('span', { class: 'chip' }, c.net + ' request' + (c.net > 1 ? 's' : '')))
  if (c.netDenied || c.policy) chips.push(el('span', { class: 'chip bad' }, (c.netDenied + c.policy) + ' denied'))
  if (st.irreversible) chips.push(el('span', { class: 'chip warn' }, 'irreversible'))
  if (st.codex) chips.push(el('span', { class: 'chip' }, 'codex'))
  if (st.agent) chips.push(el('span', { class: 'chip' }, st.agent.name + ' · ' + st.agent.tool))
  chips.push(el('span', { class: 'chip' }, time(st.startedAt)))
  return el('div', { class: 'row' + (on ? '' : ' off') + (selected === st.index ? ' sel' : ''), onclick: () => { if (selected !== st.index) flash = null; selected = st.index; render() } },
    rail(depth, (isHead ? 'head ' : '') + (st.exitCode !== 0 || st.irreversible ? 'bad' : '')),
    el('div', { class: 'body' },
      el('div', { class: 'top' }, el('span', { class: 'idx mono' }, '#' + st.index), el('span', { class: 'type ' + st.action.type }, label(st.action.type)),
        isHead ? el('span', { class: 'headtag' }, 'HEAD') : ''),
      el('span', { class: 'sum mono', title: summary(st) }, summary(st)),
      el('div', { class: 'chips' }, chips)))
}

let detailKey = ''
function showDetail() {
  const d = document.getElementById('detail')
  const { steps, meta, head } = S.session
  const pruned = new Set(S.session.pruned || [])
  const key = meta.id + ':' + selected + ':' + (selected === 'base' ? head : JSON.stringify(steps[selected])) + ':' + head + ':' + S.current
  if (key === detailKey) return
  detailKey = key
  const isCurrent = meta.id === S.current
  if (selected === 'base') {
    d.replaceChildren(el('h2', {}, 'Base'), el('p', { class: 'muted' }, 'The workdir as it was before the first step of session ' + meta.id + '.'),
      pruned.has('base') ? el('div', { class: 'banner warn' }, 'The base snapshot was dropped to stay under snapshot.maxBytes.') : isCurrent ? actions('base', head === 'base') : '')
    return
  }
  const st = steps[selected]
  if (!st) { d.replaceChildren(el('p', { class: 'empty' }, 'Select a step.')); return }
  const ms = new Date(st.endedAt) - new Date(st.startedAt)
  const groups = [
    ['Files written', st.effects.filter(e => e.kind === 'fs' && e.op === 'write').map(e => e.path)],
    ['Files deleted', st.effects.filter(e => e.kind === 'fs' && e.op === 'delete').map(e => e.path)],
    ['Network', st.effects.filter(e => e.kind === 'net').map(e => (e.denied ? 'denied ' : '') + (e.method || '') + ' ' + e.host + (e.path || '') + (e.irreversible ? '  (' + e.irreversible.rule + ', ' + e.irreversible.decision + ')' : ''))],
    ['Denied by policy', st.effects.filter(relevant).map(e => e.reason)],
    ['Processes', st.effects.filter(e => e.kind === 'proc').map(e => e.argv.join(' '))],
    ['Sandbox noise (system lookups srt denied)', st.effects.filter(e => e.kind === 'policy' && !relevant(e)).map(e => e.reason)],
  ].filter(g => g[1].length)
  const diffBox = el('div', {}, el('p', { class: 'muted' }, 'Loading changes…'))
  d.replaceChildren(
    el('h2', {}, 'Step ' + st.index + ' · ' + label(st.action.type)),
    el('pre', { class: 'cmd' }, st.action.type === 'exec' ? JSON.parse(st.action.input).join(' ') : summary(st)),
    st.irreversible ? el('div', { class: 'banner warn' }, 'Irreversible: ' + st.irreversible.reason + ' — rewind cannot undo what this sent out.') : '',
    el('dl', {},
      el('dt', {}, 'exit'), el('dd', { class: st.exitCode ? 'mono chip bad' : 'mono' }, st.exitCode),
      el('dt', {}, 'when'), el('dd', {}, new Date(st.startedAt).toLocaleString() + ' · ' + (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms')),
      el('dt', {}, 'parent'), el('dd', { class: 'mono' }, st.parent === undefined ? 'base' : '#' + st.parent),
      el('dt', {}, 'snapshot'), el('dd', { class: 'mono' }, pruned.has(st.index) ? 'pruned' : short(st.snapshot)),
      st.codex ? [el('dt', {}, 'codex call'), el('dd', { class: 'mono' }, st.codex.toolCallId)] : '',
      st.agent ? [el('dt', {}, st.agent.name), el('dd', { class: 'mono' }, st.agent.tool + (st.agent.toolUseId ? ' · ' + st.agent.toolUseId : ''))] : ''),
    pruned.has(st.index) ? el('div', { class: 'banner warn' }, 'Its snapshot was dropped to stay under snapshot.maxBytes: this step stays in the log but can no longer be rewound or forked to.') : isCurrent ? actions(st.index, st.index === head) : '',
    groups.length ? el('h3', {}, 'Effects') : '',
    ...groups.map(([name, items]) => el('details', { open: items.length <= 20 && !name.startsWith('Sandbox noise') },
      el('summary', {}, name + ' (' + items.length + ')'), el('ul', {}, items.slice(0, 1000).map(i => el('li', { class: 'mono' }, i))))),
    el('h3', {}, 'Changes'),
    diffBox,
  )
  loadDiff(meta.id, st.index, diffBox)
}

async function loadDiff(session, step, box) {
  const r = await (await fetch(API + 'diff?session=' + encodeURIComponent(session) + '&step=' + step)).json()
  if (r.unavailable) return box.replaceChildren(el('p', { class: 'muted' }, r.unavailable + '.'))
  if (r.error) return box.replaceChildren(el('p', { class: 'muted' }, r.error))
  if (!r.files.length && !r.dirs.length) return box.replaceChildren(el('p', { class: 'muted' }, 'No file changes in the workdir.'))
  box.replaceChildren(
    r.baseMissing ? el('p', { class: 'muted' }, 'The parent snapshot is gone; everything shows as added.') : '',
    ...r.files.map(f => el('div', { class: 'file' },
      el('div', { class: 'fh' }, el('span', { class: 'st ' + f.status }, f.status), el('span', { class: 'mono' }, f.path)),
      f.note ? el('div', { class: 'note' }, f.note) : '',
      ...(f.hunks || []).map(h => el('pre', { class: 'hunk' }, el('div', { class: 'hh' }, h.header),
        h.lines.map(l => el('div', { class: l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '' }, l)))))),
    r.more ? el('p', { class: 'muted' }, '… and ' + r.more + ' more file(s).') : '',
    r.dirs.length ? el('p', { class: 'muted mono' }, r.dirs.join('  ')) : '',
  )
}

function flashView(step) {
  if (!flash || flash.step !== step) return []
  const out = [el('div', { class: 'banner ' + (flash.ok ? 'ok' : 'bad') }, flash.text)]
  // Unrecorded edits block a rewind; discarding them is a second, deliberate click.
  if (flash.offerForce) {
    const f = el('button', { class: 'danger' }, 'Discard those edits and rewind')
    f.addEventListener('click', () => flash.post('rewind', { step, force: true }, [f]))
    out.push(f)
  }
  return out
}

function actions(step, isHead) {
  const msg = el('div', {}, flashView(step))
  const dir = el('input', { type: 'text', placeholder: 'fork into directory (absolute, or next to this one)', 'aria-label': 'Fork directory' })
  const post = async (route, body, buttons) => {
    if (inFlight) return
    inFlight = true
    buttons.forEach(b => (b.disabled = true))
    msg.replaceChildren(el('div', { class: 'banner' }, route === 'rewind' ? 'Rewinding…' : 'Forking…'))
    try {
      const r = await (await fetch(API + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-envgit-token': TOKEN }, body: JSON.stringify(body) })).json()
      const text = (r.stderr || r.error || '').trim().replace(/^envgit: /gm, '')
      flash = { step, ok: r.code === 0, text: text || (r.code === 0 ? 'Done.' : 'Failed.'), offerForce: route === 'rewind' && r.code !== 0 && /--force/.test(text) && !body.force, post }
      msg.replaceChildren(...flashView(step))
      lastKey = ''
      detailKey = ''
      await load()
    } finally {
      inFlight = false
      buttons.forEach(b => (b.disabled = false))
    }
  }
  const rw = el('button', { class: 'primary', disabled: isHead, title: isHead ? 'already here' : '' }, isHead ? 'Current state' : 'Rewind to here')
  const fk = el('button', {}, 'Fork')
  rw.addEventListener('click', () => post('rewind', { step }, [rw, fk]))
  fk.addEventListener('click', () => dir.value.trim() ? post('fork', { step, dir: dir.value.trim() }, [rw, fk]) : dir.focus())
  return el('div', {}, el('div', { class: 'actions' }, rw, dir, fk), msg)
}

document.getElementById('session').addEventListener('change', e => { chosenSession = e.target.value; selected = null; detailKey = ''; lastKey = ''; load() })
load()
setInterval(load, 1500)
</script>
</body>
</html>
`
