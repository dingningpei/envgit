# STATUS · envgit

> 每次会话结束前更新本文件的「上次做到哪」和「下一步」，随代码一起 commit。
> 状态：**活跃** | 分支 `main` | 更新于 2026-11-14（初稿由 Claude 根据 commit 记录推断，请校对）

## 当前目标
0.3（M8，`docs/design.md` §5 第 9 条，2026-11-14 按 §7.3 改写）：**沙箱里没有可偷的东西，agent 也不被人拦住**。方向定为权限（默认拒读、凭据不进沙箱、不可逆动作在请求层拦截），记录是证据，回退是附带功能。先让作者自己在 `envgit claude` 下跑 10 个工作日，再决定是否重新发 Show HN。

## 上次做到哪（2026-11-12）
- 发布两周后复盘（`docs/design.md` §7.2）：HN 帖子（https://news.ycombinator.com/item?id=50293944）1 分、4 条有效评论（都在回应 `~/.ssh` 的开头或文风，没人谈到请求级拦截或 rewind）；GitHub 14 天 27 个独立访客、1 star、0 issue。结论是「没被看到」，不是「被否定」。帖子标题没带 `Show HN:` 前缀。
- 现状核对：`envgit doctor` 通过，`npm test` 146 通过 / 22 跳过（vm），但本机 agent 还是发布时的版本；npm 上已是 Claude Code 2.1.323、Codex 0.168.0、Copilot CLI 1.0.110，都没测过。
- 发现：作者自己没在日常用 envgit（这台 Mac 上只有本仓库有 `.envgit`，最长会话 15 步；x86 台式机没查）；Claude Code 除了 `envgit claude` 包装之外没有接入路径（桌面 app / IDE 不能记录）。
- 定了 M8（0.3）规划：`docs/design.md` §5 第 9 条，2026-11-14 采纳。
- 方向决定（`docs/design.md` §7.3）：权限是产品，版本控制降为附带功能；五条原则（靠结构保证安全而不是靠问人、边界内不拦 agent、边界上由策略即时决定、只有不可逆动作才问人且不挡路、全部记录）。M8 据此重写：第一项是去掉逐条确认，凭据不进沙箱从 0.4 提到 0.3，记录模式降到 0.4 候选。
- 快照设计方向（`docs/design.md` §3.6 末尾，计划中、未实现）：每一步只存文件清单，内存镜像只在「有进程存活 / 回合结束 / 不可逆动作放行前」作为关键帧存；回退时恢复最近关键帧再推入文件差异。三个未决问题写在同一处。M8 spike 的第一个问题相应改成「能否对运行中的 actor 只做文件快照」。
- README 顶部改版：居中的 logo、徽章、导航链接和一张时间线示意图（`docs/assets/logo.svg`、`docs/assets/hero.svg`），demo GIF 移到「See it run」下。
- 方向补充（2026-11-14）：终局是云服务器上跑很多 agent。那里沙箱运行时已有 Agent Substrate 这类项目在做，envgit 的位置是它上面的记录和控制层；本机 srt 后端是试用和开发入口。
- 对比了 OpenAI Pando / Anthropic Scion：都是内部源码版本控制，和 envgit 不在一层；按用户决定没有写进 §8。

## 下一步
- **下一步**：M8 第一项，`envgit claude` 去掉逐条命令确认（先查用哪个启动参数、hook 返回的 `ask` 在该模式下是否还能问到人），token 改为可从 `~/.config/envgit/` 下的 0600 文件读。
- 之后依次：无人值守时 `ask` 规则不等人（默认拒绝并记录）；凭据不进沙箱、由 gate 出站时注入（先查 sandbox-runtime 自带的 `mask`）；在最新版 agent 上重跑 M5 的真实会话检查；自己用 10 个工作日；README 改回权限叙事；Substrate spike（只问 gate 能否挂到它的 egress 策略点）；发 0.3.0 后决定。
- 0.4 候选：多 agent 的统一审批队列（批准沉淀成规则）、从记录生成最小权限策略、SSH 密钥能用但读不到、记录模式（`hooks install claude`）。
- 暂停：§3.6 的关键帧快照、VM 后端、M6（GUI agents）。

## 待我决定
（暂无）
