# STATUS · envgit

> 每次会话结束前更新本文件的「上次做到哪」和「下一步」，随代码一起 commit。
> 状态：**活跃** | 分支 `main` | 更新于 2026-11-14（初稿由 Claude 根据 commit 记录推断，请校对）

## 当前目标
0.3（M8，`docs/design.md` §5 第 9 条，2026-11-14 按 §7.3 改写）：**沙箱里没有可偷的东西，agent 也不被人拦住**。方向定为权限（默认拒读、凭据不进沙箱、不可逆动作在请求层拦截），记录是证据，回退是附带功能。先让作者自己在 `envgit claude` 下跑 10 个工作日，再决定是否重新发 Show HN。

## 上次做到哪（2026-11-16）
- 发布两周后复盘（`docs/design.md` §7.2）：HN 帖子（https://news.ycombinator.com/item?id=50293944）1 分、4 条有效评论（都在回应 `~/.ssh` 的开头或文风，没人谈到请求级拦截或 rewind）；GitHub 14 天 27 个独立访客、1 star、0 issue。结论是「没被看到」，不是「被否定」。帖子标题没带 `Show HN:` 前缀。
- 现状核对：`envgit doctor` 通过，`npm test` 146 通过 / 22 跳过（vm），但本机 agent 还是发布时的版本；npm 上已是 Claude Code 2.1.323、Codex 0.168.0、Copilot CLI 1.0.110，都没测过。
- 发现：作者自己没在日常用 envgit（这台 Mac 上只有本仓库有 `.envgit`，最长会话 15 步；x86 台式机没查）；Claude Code 除了 `envgit claude` 包装之外没有接入路径（桌面 app / IDE 不能记录）。
- 定了 M8（0.3）规划：`docs/design.md` §5 第 9 条，2026-11-14 采纳。
- **M8 第二项完成（已合并到 main：PR dingningpei/envgit#2，Linux CI 通过）**：无人值守时 `ask` 规则不等人。查下来发现没人时 gate 本来就立刻拒绝，缺的是记录和开关，所以实际做的是：被规则拒绝的命令现在记成一步（exit 126、带原因，`log` / `show` 可见），`envgit run` 和 hooks 都记；`ENVGIT_UNATTENDED=1` 关掉终端询问、MCP elicitation 和 hook 的 `ask`；`envgit claude -p` 或没有终端时自动视为无人值守，hook 直接拒绝并告诉 agent 原因和「继续做别的」。没有新增策略字段（规则自己的 `action` 就是）。真实 `envgit claude -p` 会话验证过；macOS `npm test` 150 通过 / 22 跳过。没做的：人在 agent 的弹窗里点「拒绝」的那次仍然不留记录；vm 后端的拒绝只打印不记录。
- **M8 第一项基本完成（已合并到 main：PR dingningpei/envgit#1，Linux CI 通过）**：`envgit claude` 不再逐条确认。做法不是切权限模式，而是 wrapper 内的 pre hook 对未命中规则的调用回答 `allow`（Bash、文件工具、WebFetch、WebSearch、所有 MCP 工具）；shell 的 `ask` / `deny` 规则照旧。token 可放在 `~/.config/envgit/claude-oauth-token`。顺带堵了两个原来靠弹窗挡着的洞：沙箱内不能写 `~/.claude/settings.json` 等用户级配置，任何 srt 沙箱都不能读 `~/.config/envgit/`。真实 Claude Code 2.1.300 `-p` 会话验证过（Bash 和 Write 直接运行，`git push` 的 ask 和 `npm publish` 的 deny 都带着 envgit 的理由被拒）；`npm test`（macOS）148 通过 / 22 跳过。细节在 design.md §3.4。
- 真实会话顺带暴露并修掉一个老问题（影响所有 srt 运行，不只 `envgit claude`）：沙箱里没有可用的临时目录，zsh 的 heredoc（Claude Code 写 commit message 的常用写法）必然失败；策略里的 `/tmp` 在 macOS 上因为是符号链接而完全不生效。现在每个沙箱有自己的临时目录，策略里的绝对路径同时按真实路径生效。
- 交互验收（2026-11-15，作者在 `~/envgit-try` 跑的，会话处于 auto 模式）：Write、Edit 和四条 shell 命令全程无弹窗；`echo approve-me` 和 `git push` 各弹出一次确认，理由是 envgit 给的，同意后执行。另外用 `-p --permission-mode default` 复验了「放行来自 hook 而不是权限模式」。
- **还没验的**：(1) 普通（非 auto）模式下的交互会话、50 次以上调用的长会话、一次真正在请求层被拒的 push；(2) Linux 上只跑了 CI 的测试套件，没有用真实的 Claude Code 跑过：那里对不存在的拒写路径（`~/.claude/commands`、`skills` 等）会临时挂占位文件，Claude Code 是否受影响未知。
- 用的时候发现：agent 的 `git add -A` 会把 `.envgit/` 一起提交（两次会话都出现）。`envgit init` 应该把 `.envgit` 写进 `.git/info/exclude` 或提示加 `.gitignore`，还没做。
- 方向决定（`docs/design.md` §7.3）：权限是产品，版本控制降为附带功能；五条原则（靠结构保证安全而不是靠问人、边界内不拦 agent、边界上由策略即时决定、只有不可逆动作才问人且不挡路、全部记录）。M8 据此重写：第一项是去掉逐条确认，凭据不进沙箱从 0.4 提到 0.3，记录模式降到 0.4 候选。
- 快照设计方向（`docs/design.md` §3.6 末尾，计划中、未实现）：每一步只存文件清单，内存镜像只在「有进程存活 / 回合结束 / 不可逆动作放行前」作为关键帧存；回退时恢复最近关键帧再推入文件差异。三个未决问题写在同一处。M8 spike 的第一个问题相应改成「能否对运行中的 actor 只做文件快照」。
- README 顶部改版：居中的 logo、徽章、导航链接和一张时间线示意图（`docs/assets/logo.svg`、`docs/assets/hero.svg`），demo GIF 移到「See it run」下。
- 方向补充（2026-11-14）：终局是云服务器上跑很多 agent。那里沙箱运行时已有 Agent Substrate 这类项目在做，envgit 的位置是它上面的记录和控制层；本机 srt 后端是试用和开发入口。
- 对比了 OpenAI Pando / Anthropic Scion：都是内部源码版本控制，和 envgit 不在一层；按用户决定没有写进 §8。

## 下一步
- **下一步**：M8 第三项（凭据不进沙箱、由 gate 出站时注入，先查 sandbox-runtime 自带的 `mask`）。日常开发开始改用 `envgit claude`，攒够一次 50 步以上的会话；台式机开机后用真实 Claude Code 在 Linux 上跑一次。顺手修：`envgit init` 把 `.envgit` 写进 git 的排除列表。
- 之后依次：无人值守时 `ask` 规则不等人（默认拒绝并记录）；凭据不进沙箱、由 gate 出站时注入（先查 sandbox-runtime 自带的 `mask`）；在最新版 agent 上重跑 M5 的真实会话检查；自己用 10 个工作日；README 改回权限叙事；Substrate spike（只问 gate 能否挂到它的 egress 策略点）；发 0.3.0 后决定。
- 0.4 候选：多 agent 的统一审批队列（批准沉淀成规则）、从记录生成最小权限策略、SSH 密钥能用但读不到、记录模式（`hooks install claude`）。
- 暂停：§3.6 的关键帧快照、VM 后端、M6（GUI agents）。

## 待我决定
（暂无）
