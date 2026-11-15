# STATUS · envgit

> 每次会话结束前更新本文件的「上次做到哪」和「下一步」，随代码一起 commit。
> 状态：**活跃** | 分支 `main` | 更新于 2026-11-14（初稿由 Claude 根据 commit 记录推断，请校对）

## 当前目标
0.3（M8「一个人每天在用」，`docs/design.md` §5 第 9 条）。0.2.1 发布两周后没有外部用户（§7.2），所以先让作者自己在 envgit 下跑真实的 agent 会话并愿意继续用，再决定是否重新发 Show HN。

## 上次做到哪（2026-11-12）
- 发布两周后复盘（`docs/design.md` §7.2）：HN 帖子（https://news.ycombinator.com/item?id=50293944）1 分、4 条有效评论（都在回应 `~/.ssh` 的开头或文风，没人谈到请求级拦截或 rewind）；GitHub 14 天 27 个独立访客、1 star、0 issue。结论是「没被看到」，不是「被否定」。帖子标题没带 `Show HN:` 前缀。
- 现状核对：`envgit doctor` 通过，`npm test` 146 通过 / 22 跳过（vm），但本机 agent 还是发布时的版本；npm 上已是 Claude Code 2.1.323、Codex 0.168.0、Copilot CLI 1.0.110，都没测过。
- 发现：作者自己没在日常用 envgit（这台 Mac 上只有本仓库有 `.envgit`，最长会话 15 步；x86 台式机没查）；Claude Code 除了 `envgit claude` 包装之外没有接入路径（桌面 app / IDE 不能记录）。
- 定了 M8（0.3）规划：`docs/design.md` §5 第 9 条，2026-11-14 采纳。
- 对比了 OpenAI Pando / Anthropic Scion：都是内部源码版本控制，和 envgit 不在一层；按用户决定没有写进 §8。

## 下一步
- **下一步**：M8 第一项是 `envgit hooks install claude`（记录模式），先验证桌面 app 和 IDE 扩展是否执行项目级 hooks；同时在最新版 agent 上重跑 M5 的真实会话检查。
- 之后：`envgit claude` 去掉逐条命令确认；作者自己连续 10 个工作日在 envgit 下跑真实会话，问题记到 GitHub Issues；0.3.0 发布后再决定是否重新发 Show HN。
- M6（GUI agents）继续搁置：没有人提需求。

## 待我决定
（暂无）
