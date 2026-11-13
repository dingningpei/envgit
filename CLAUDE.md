# Instructions for coding agents working in this repo

- Read `STATUS.md` first: current goal, where the last session stopped, next step, and
  decisions waiting on the user. `docs/design.md` is the design and milestone plan
  (§5 milestones, §7 reviews).
- Before ending a session, update the "where we stopped" and "next step" sections of
  `STATUS.md` and commit them with the code. Changing the "decisions waiting on the user"
  list needs the user's go-ahead first.
- Releases: bump `package.json`, one commit titled `<version>: <what changed>`, then
  `npm publish`.
