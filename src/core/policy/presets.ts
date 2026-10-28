/**
 * Stock irreversible rules, used as `- preset: default` in a policy's `irreversible:` list and expanded
 * there in place by the loader (docs/design.md §4). Rules match first to last, so a rule written
 * before the preset line overrides it (`action: allow` for a repo of your own, say).
 *
 * Each covers something that crosses the snapshot boundary in a developer's day: a rewind cannot take
 * it back. Net rules are what enforce; shell rules catch the usual command lines early and give a
 * clearer message. Three paths the gate cannot judge by request line are closed another way:
 * - `git push` over SSH: SSH is opaque, so every SSH connection is refused at the proxy (`tunnel`),
 *   with a reason the ssh client prints — fetch and clone over SSH too; https:// remotes are judged.
 * - `docker push`: the daemon pushes, outside the sandbox. Its socket stays out (`socket`; unix
 *   sockets are refused unless network.allowUnixSockets names them), and a daemon over TCP is judged
 *   by its push endpoint.
 * - GraphQL mutations: `/graphql` is a POST for reads too, so the rule reads the body.
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
    // REST writes; /graphql below.
    {
      name: 'GitHub API write',
      net: { host: 'api.github.com', method: WRITE, path: ['/repos/**', '/orgs/**', '/user', '/user/**', '/gists', '/gists/**', '/projects/**', '/teams/**'] },
    },
    { name: 'GitLab API write', net: { host: 'gitlab.com', method: WRITE, path: '/api/v4/**' } },
    // A query string that holds `mutation` anywhere (a comment, a string) is asked about too.
    { name: 'GitHub GraphQL mutation', net: { host: 'api.github.com', method: 'POST', path: '/graphql', body: { contains: 'mutation' } } },
    { name: 'GitLab GraphQL mutation', net: { host: 'gitlab.com', method: 'POST', path: '/api/graphql', body: { contains: 'mutation' } } },
    { name: 'git push over SSH', tunnel: '*:22' },
    { name: 'docker daemon', socket: ['**/docker.sock', '**/podman.sock', '**/containerd.sock', '**/buildkitd.sock'] },
    // The Engine API over TCP (DOCKER_HOST=tcp://…), versioned or not.
    { name: 'docker push', net: { host: '*', method: 'POST', path: ['/images/**/push', '/*/images/**/push'] } },
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
