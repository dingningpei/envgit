/**
 * Stock irreversible rules, used as `- preset: default` in a policy's `irreversible:` list and expanded
 * there in place by the loader (docs/design.md §4). Rules match first to last, so a rule written
 * before the preset line overrides it (`action: allow` for a repo of your own, say).
 *
 * Each covers something that crosses the snapshot boundary in a developer's day: a rewind cannot take
 * it back. Net rules are what enforce; shell rules catch the usual command lines early and give a
 * clearer message. Not covered: GraphQL mutations (`api.github.com/graphql` is a POST for reads too,
 * and rules cannot see bodies), `git push` over SSH and `docker push` (the daemon is outside the
 * sandbox), which only the shell rules see.
 */
import type { IrreversibleRule } from './schema.js'

const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE']

export const PRESETS: Record<string, IrreversibleRule[]> = {
  default: [
    // Smart HTTP: GitHub, GitLab, Bitbucket, Gitea, self-hosted alike.
    { name: 'git push', net: { host: '*', method: 'POST', path: '/**/git-receive-pack' } },
    { name: 'npm publish/unpublish', net: { host: 'registry.npmjs.org', method: ['PUT', 'DELETE'] } },
    { name: 'PyPI upload', net: { host: 'upload.pypi.org', method: 'POST' } },
    { name: 'cargo publish/yank', net: { host: 'crates.io', method: ['PUT', 'DELETE'], path: '/api/v1/crates/**' } },
    // The manifest is the last write of an image push, on any registry speaking the OCI API.
    { name: 'container image push', net: { host: '*', method: 'PUT', path: '/v2/**/manifests/*' } },
    // REST writes; /graphql is left alone (see above).
    {
      name: 'GitHub API write',
      net: { host: 'api.github.com', method: WRITE, path: ['/repos/**', '/orgs/**', '/user', '/user/**', '/gists', '/gists/**', '/projects/**', '/teams/**'] },
    },
    { name: 'GitLab API write', net: { host: 'gitlab.com', method: WRITE, path: '/api/v4/**' } },
    {
      name: 'publish or deploy command',
      shell: [
        'git push',
        'npm publish',
        'npm unpublish',
        'pnpm publish',
        'yarn npm publish',
        'cargo publish',
        'twine upload',
        'docker push',
        'gh pr merge',
        'gh release create',
        'terraform apply',
        'terraform destroy',
      ],
    },
  ],
}
