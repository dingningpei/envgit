#!/usr/bin/env node
const [cmd = 'help'] = process.argv.slice(2)

const help = `envgit — version control for agent execution environments

  envgit init            create .envgit/ and a default policy
  envgit run <cmd...>    run a command in the sandbox, record a step
  envgit log             show steps
  envgit fork <step>     fork the environment at a step
  envgit rewind <step>   rewind the environment to a step

(all commands are stubs — see docs/design.md)`

switch (cmd) {
  default:
    console.log(help)
}
