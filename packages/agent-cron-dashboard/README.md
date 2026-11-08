# agent-cron-dashboard

dsh 工作台主 bundle：社区 PR/Issue 监控 + 定时任务巡检 + 错误分析闭环 + Web GUI 工作台页。

安装后在 profile 中出现行 `workbench`（配置在 `cordis.patch.yml`）。P0 提供配置校验、七个存储域与可 inspect 的服务骨架；P2-P7 逐节补齐采集、分析、通知与 UI。

配置样例见仓根 `contracts/config.schema.json`；**凭据只认环境变量名**（`tokenEnv`），配置里出现 token 字面值会被拒绝。

## Issue 轮询（P3）

`src/community/issue-watch*.ts` 轮询「我提交的 issue」：GitHub 走 `search/issues`（第一页 50 条）＋逐条详情（`If-None-Match` 304 时零写入、零评论读）＋评论页；GitCode 走 `/user/issues`（需要 `private-token`，无令牌时平台显名 `down`）＋逐条详情＋评论页 1（实测最新在前）。

- 快照写 `workbench.snapshot.issue`（键 `<platform>/<owner>/<repo>/<number>`），只在被比较的七个字段变化时写：`state/labels/assignees/comments/lastCommentBy/lastCommentAt/title`。
- 快照对按 P2 的队列形态存 `workbench.cursors` 键 `<key>:issuequeue`（200 对容量，首见 `before: null`），`drainQueue(key)` 供 P4 消费；首见类事件 kind 由 P4 造（`issue-seeded`，ADR P3-1）。
- 平台计数/失败行/种子摘要写 `workbench.cursors` 键 `issue:<platform>`；轮询间隔 `watch.issuePollIntervalMs`（默认 5 分钟），失败平台独立指数退避（上限 10 分钟）。
- GitCode 实测差异（端点、分页、评论顺序、`search/issues` 覆盖不全）见仓外 `../docs/probes/p3-gitcode-issues.md` 与 `../docs/gitcode-v5-diff.md` §7。
