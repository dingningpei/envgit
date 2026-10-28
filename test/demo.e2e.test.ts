import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url))
const run = promisify(execFile)

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('envgit demo (e2e, needs `npm run build`)', () => {
  it('runs five steps, refuses the push at the request, and rewinds', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'demo'])
    expect(stdout).toMatch(/step 3 {2}agent: release it\n {2}\$ envgit run sh release\.sh\n/)
    expect(stdout).toMatch(/envgit: denied POST 127\.0\.0\.1\/demo\/app\.git\/git-receive-pack \(git push\)/)
    expect(stdout).toContain('the remote saw: GET /demo/app.git/info/refs?service=git-receive-pack\n')
    expect(stdout).toMatch(/\n {8}3 .* exit 1 .*sh release\.sh +1 denied\n/)
    expect(stdout).toMatch(/envgit: rewound to step 2 \(2 step\(s\) undone\)\n.*\n {4}\w+ add greet\.js\n {4}\w+ release script\n {4}console\.log/)
  }, 60_000)
})
