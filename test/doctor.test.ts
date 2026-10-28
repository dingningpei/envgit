import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { doctor, TESTED, type Host } from '../src/cli/doctor.js'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))

function host(over: Partial<Host> & { versions?: Record<string, string>; files?: Record<string, string> } = {}): Host {
  const versions: Record<string, string> = { rg: 'ripgrep 14.1.0', claude: `${TESTED.claude} (Claude Code)`, codex: `codex-cli ${TESTED.codex}`, sw_vers: '15.4', sysctl: 'Apple M3 Pro', ...over.versions }
  return {
    platform: 'darwin',
    node: 'v22.12.0',
    env: {},
    run: async cmd => versions[cmd],
    read: async p => over.files?.[p],
    usable: async () => true,
    srtDeps: () => ({ errors: [], warnings: [] }),
    sandbox: async () => undefined,
    ...over,
  }
}

const find = (checks: { what: string }[], re: RegExp) => checks.find(c => re.test(c.what))

describe('envgit doctor', () => {
  it('passes a machine with everything, agents optional', async () => {
    const checks = await doctor(host())
    expect(checks.filter(c => c.status === 'fail')).toEqual([])
    expect(find(checks, /Claude Code/)).toMatchObject({ status: 'ok' })
    expect(find(checks, /Copilot CLI not found/)).toMatchObject({ status: 'info' })
  })

  it('says a host NODE_USE_SYSTEM_CA does not reach the sandbox, and where a corporate CA goes', async () => {
    expect(find(await doctor(host()), /NODE_USE_SYSTEM_CA/)).toBeUndefined()
    expect(find(await doctor(host({ env: { NODE_USE_SYSTEM_CA: '1' } })), /NODE_USE_SYSTEM_CA/)).toMatchObject({ status: 'info', fix: expect.stringMatching(/network\.extraCaCertPaths/) })
  })

  it('fails an old Node, with the fix', async () => {
    expect(find(await doctor(host({ node: 'v20.11.0' })), /^Node/)).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Node 22/) })
  })

  it('names the AppArmor sysctl when the sandbox cannot start on Ubuntu 24.04', async () => {
    const checks = await doctor(
      host({
        platform: 'linux',
        sandbox: async () => 'bwrap: setting up uid map: Permission denied',
        files: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' },
        srtDeps: () => ({ errors: ['socat not found'], warnings: [] }),
        versions: { bwrap: 'bubblewrap 0.9.0', rg: 'ripgrep 14.1.0' },
      }),
    )
    expect(find(checks, /^sandbox/)).toMatchObject({ status: 'fail', fix: expect.stringMatching(/apparmor_restrict_unprivileged_userns=0/) })
    expect(find(checks, /socat not found/)).toMatchObject({ status: 'fail', fix: expect.stringMatching(/apt install/) })
    expect(find(checks, /^bubblewrap 0\.9\.0$/)).toMatchObject({ status: 'ok' })
  })

  it('warns about an agent older than the one tested, and about no ripgrep on macOS', async () => {
    const checks = await doctor(host({ versions: { codex: 'codex-cli 0.150.0', rg: '' } }))
    expect(find(checks, /Codex 0\.150\.0 is older/)).toMatchObject({ status: 'warn' })
    expect(find(checks, /ripgrep not found/)).toMatchObject({ status: 'warn', fix: 'brew install ripgrep' })
  })

  it('treats the vm backend as optional', async () => {
    const checks = await doctor(host({ platform: 'linux', usable: async () => false }))
    expect(find(checks, /\/dev\/kvm/)).toMatchObject({ status: 'info', fix: expect.stringMatching(/kvm/) })
  })

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('runs here, before `envgit init` (e2e, needs `npm run build`)', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'doctor'], { cwd: '/' })
    expect(stdout).toMatch(/ok {4}sandbox: srt ran a command/)
    expect(stdout).toMatch(/envgit can run here/)
  }, 30_000)
})
