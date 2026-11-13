# STATUS · envgit

> 每次会话结束前更新本文件的「上次做到哪」和「下一步」，随代码一起 commit。
> 状态：**活跃** | 分支 `main` | 更新于 2026-11-12（初稿由 Claude 根据 commit 记录推断，请校对）

## 当前目标
0.2（M7「留住第一批用户」）已发 0.2.1 到 npm，launch post 已写好（`docs/launch-post.md`）。目标是让前 50 个试用者能装上、用起来、回来提问而不是撞死胡同。

## 上次做到哪（2026-11-12）
- Show HN 已发：https://news.ycombinator.com/item?id=50293944
- 定了：0.2.x 反馈统一收到 GitHub Issues（Discussions 不开）。
- M7 的两个 worktree（`m7-show-diff`、`claude/m7-envgit-preset-export-…`）已全部并入 main，worktree 和分支已删除。
- 0.2.1 发布：sandbox 里不再有 system-store 噪音；`network.extraCaCertPaths`。
- 0.2.0：`envgit demo`（--pace/--help）、README 顶部 GIF、`show`/`diff`、`export`/`import`、`doctor`。
- `docs/design.md` §7.1 复盘：M7 先于 M6（GUI agents）；M6 是否做取决于有没有人要。

## 下一步
- **下一步**：盯 Show HN 帖子的评论，收集前 50 个用户的安装/使用反馈，按反馈修 0.2.x。
- 之后：根据反馈决定 M6（GUI agents）是否启动。

## 待我决定
（暂无）
