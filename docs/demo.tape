# The README's GIF: `npm run build`, then `vhs docs/demo.tape` from the repo root.
# NODE_USE_SYSTEM_CA is unset because Node then reads the macOS keychain, which the sandbox does not reach.
Output docs/demo.gif
Set Shell zsh
Set FontSize 16
Set Width 1400
Set Height 1000
Set TypingSpeed 60ms
Hide
Type `alias envgit="node $PWD/dist/cli/index.js"; unset NODE_USE_SYSTEM_CA; export PS1='$ '; cd $(mktemp -d); clear`
Enter
Sleep 500ms
Show
Type "envgit demo --pace 1200"
Enter
Sleep 14s
