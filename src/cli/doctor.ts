/**
 * `envgit doctor`: what a sandbox tool breaks on, checked on this machine, each with its fix
 * (docs/design.md §5 M7). Runs without `envgit init`: it is what to run when that fails.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { SrtBackend } from '../core/env/srt.js'
import { vmDir } from '../core/env/vm.js'

/** The agent versions envgit was last checked against (docs/design.md §3.4). */
export const TESTED = { claude: '2.1.300', codex: '0.162.1', copilot: '1.0.104' }

export interface Check {
  /** `fail`: envgit will not work; `warn`: something will not; `info`: optional and absent. */
  status: 'ok' | 'warn' | 'fail' | 'info'
  what: string
  fix?: string
}

/** The machine, as doctor sees it; tests pass their own. */
export interface Host {
  platform: NodeJS.Platform
  node: string
  /** A command's output (stdout, else stderr), or undefined when it is missing or fails. */
  run(cmd: string, args: string[]): Promise<string | undefined>
  read(path: string): Promise<string | undefined>
  /** Whether this user can read and write the path. */
  usable(path: string): Promise<boolean>
  /** srt's own dependency check. */
  srtDeps(): { errors: string[]; warnings: string[] }
  /** Runs a command in an srt sandbox; returns why that failed, or undefined. */
  sandbox(): Promise<string | undefined>
}

const firstLine = (s: string | undefined) => s?.split('\n').find(l => l.trim())?.trim()
const version = (s: string | undefined) => s?.match(/\d+\.\d+(\.\d+)?/)?.[0]

function older(a: string, b: string): boolean {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) < (y![i] ?? 0)
  return false
}

export async function doctor(h: Host): Promise<Check[]> {
  const out: Check[] = []
  const linux = h.platform === 'linux'

  const major = Number(h.node.replace(/^v/, '').split('.')[0])
  out.push(major >= 22 ? { status: 'ok', what: `Node ${h.node}` } : { status: 'fail', what: `Node ${h.node}: envgit needs Node 22 or later`, fix: 'install Node 22+ (nodejs.org, or `nvm install 22`)' })

  if (h.platform !== 'darwin' && !linux) {
    out.push({ status: 'fail', what: `${h.platform}: the srt sandbox runs on macOS and Linux only` })
    return out
  }

  // Linux: what srt itself needs, with versions, then whether user namespaces are allowed.
  if (linux) {
    const deps = h.srtDeps()
    for (const e of deps.errors) out.push({ status: 'fail', what: `srt: ${e}`, fix: 'sudo apt install bubblewrap socat ripgrep (Debian/Ubuntu), or your distribution\'s packages' })
    for (const w of deps.warnings) out.push({ status: 'warn', what: `srt: ${w}` })
    for (const [name, cmd, args] of [['bubblewrap', 'bwrap', ['--version']], ['socat', 'socat', ['-V']], ['ripgrep', 'rg', ['--version']]] as const) {
      const v = await h.run(cmd, [...args])
      if (v) out.push({ status: 'ok', what: `${name} ${version(v) ?? firstLine(v)}` })
    }
  } else {
    const rg = await h.run('rg', ['--version'])
    out.push(rg ? { status: 'ok', what: `ripgrep ${version(firstLine(rg))}` } : { status: 'warn', what: 'ripgrep not found: Codex searches with `rg`, and in the sandbox it finds nothing else', fix: 'brew install ripgrep' })
  }

  const why = await h.sandbox()
  if (!why) out.push({ status: 'ok', what: `sandbox: srt ran a command (${linux ? 'bubblewrap' : 'Seatbelt'})` })
  else {
    const userns = linux && (await h.read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'))?.trim() === '1'
    out.push({
      status: 'fail',
      what: `sandbox: srt could not run a command: ${why}`,
      ...(userns
        ? { fix: 'AppArmor keeps unprivileged user namespaces from bubblewrap (Ubuntu 24.04+): sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0, and put it in /etc/sysctl.d/ to keep it' }
        : linux && { fix: 'check that bubblewrap can create user namespaces: bwrap --ro-bind / / true' }),
    })
  }

  // Agents are optional; a version older than the one tested is worth knowing about.
  for (const [name, cmd, tested, use] of [
    ['Claude Code', 'claude', TESTED.claude, '`envgit claude`'],
    ['Codex', 'codex', TESTED.codex, '`envgit codex`'],
    ['Copilot CLI', 'copilot', TESTED.copilot, '`envgit hooks install copilot`'],
  ] as const) {
    const v = version(firstLine(await h.run(cmd, ['--version'])))
    if (!v) out.push({ status: 'info', what: `${name} not found (only for ${use})` })
    else if (older(v, tested)) out.push({ status: 'warn', what: `${name} ${v} is older than the version envgit was checked against (${tested})`, fix: `update ${name}` })
    else out.push({ status: 'ok', what: `${name} ${v}${v === tested ? '' : ` (checked against ${tested})`}` })
  }

  // The vm backend (policy `backend: vm`) only.
  if (linux) {
    out.push(
      (await h.usable('/dev/kvm'))
        ? { status: 'ok', what: 'vm backend: /dev/kvm is usable' }
        : { status: 'info', what: 'vm backend: /dev/kvm is missing or not usable by this user (only for backend: vm)', fix: 'enable virtualization, then: sudo usermod -aG kvm $USER (and log in again)' },
    )
  } else {
    const chip = firstLine(await h.run('sysctl', ['-n', 'machdep.cpu.brand_string'])) ?? ''
    const m = Number(chip.match(/Apple M(\d+)/)?.[1] ?? 0)
    const os = version(firstLine(await h.run('sw_vers', ['-productVersion']))) ?? '0'
    if (m < 3 || older(os, '15.0'))
      out.push({ status: 'info', what: `vm backend: needs an Apple M3 or later on macOS 15+ for nested virtualization; this is ${chip || 'an unknown chip'} on macOS ${os} (only for backend: vm)` })
    else out.push({ status: 'ok', what: `vm backend: ${chip}, macOS ${os}` })
  }
  const built = await h.read(join(vmDir(), 'build', 'image-stamp'))
  out.push(built ? { status: 'ok', what: `vm backend: built (${vmDir()})` } : { status: 'info', what: 'vm backend: not built (only for backend: vm)', fix: 'scripts/vm/build.sh from the envgit source' })
  return out
}

export const realHost: Host = {
  platform: process.platform,
  node: process.version,
  run: (cmd, args) =>
    new Promise(resolve =>
      execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => resolve(err ? undefined : String(stdout).trim() || String(stderr).trim())),
    ),
  read: path => readFile(path, 'utf8').catch(() => undefined),
  usable: path => access(path, constants.R_OK | constants.W_OK).then(() => true, () => false),
  srtDeps: () => SandboxManager.checkDependencies(),
  sandbox: async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'envgit-doctor-')))
    const backend = new SrtBackend()
    try {
      const env = await backend.create({ workdir: dir, policy: { filesystem: { write: { allow: [dir] } } } })
      const { child } = await backend.spawn(env, { argv: ['/bin/sh', '-c', 'echo ok > probe && cat probe'] }, ['ignore', 'pipe', 'pipe'])
      let out = ''
      child.stdout!.on('data', b => (out += b))
      child.stderr!.on('data', b => (out += b))
      const code = await new Promise<number>(r => child.on('close', c => r(c ?? 1)))
      await backend.destroy(env)
      return code === 0 && out.trim() === 'ok' ? undefined : `exit ${code}: ${firstLine(out) ?? 'no output'}`
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
}

/** Prints the checks; exit 1 when something envgit needs is missing. */
export async function runDoctor(host: Host = realHost, pkg = 'agent-envgit'): Promise<number> {
  console.log(`envgit doctor: ${pkg} on ${host.platform} ${process.arch}`)
  const checks = await doctor(host)
  for (const c of checks) {
    console.log(`  ${c.status.padEnd(4)}  ${c.what}`)
    if (c.fix && c.status !== 'ok') console.log(`        fix: ${c.fix}`)
  }
  const failed = checks.filter(c => c.status === 'fail').length
  console.log(failed ? `${failed} problem(s) envgit cannot work around; paste this output into an issue if a fix does not help` : 'envgit can run here')
  return failed ? 1 : 0
}
