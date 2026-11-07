# agent-cron-dashboard

> dsh（DeepSeek Harness）个人工作台插件——agent 定时任务看板＋社区 PR/Issue 监控
> 状态：**规划中（P0 未启动）**｜设计与计划见仓外 `../docs/设计方案.md` 与 `../plan-of-plans/`
> 本目录＝发布仓本体：git init、双 npm 包、市场提交物全在此层；外层 `dsh-dev/` 只保留规划/过程文档

## 是什么（两个发布包，pnpm monorepo）

| 包 | 角色 |
|---|---|
| `packages/dsh-forge-gitcode` | GitCode 的 `dsh-experimental-forge` provider——PR/MR 轮询/检查/可合并性接入 forge 注册表 |
| `packages/agent-cron-dashboard` | 主 bundle：host 服务（采集/分析/通知）＋Web UI 工作台页＋agent 工具 |

功能面：

1. **社区监控**：跨 GitHub/GitCode 盯我提交的 issue/PR——CI、评审、可合并性、状态跃迁通知、每日摘要
2. **Fleet 定时任务监控**：NAS hermes（ssh 只读 SQLite）／GMK jiuwenswarm（本地）／通用 ssh-sqlite 源——巡检报错全量采集、指纹去重、LLM 根因分析、修复登记、**连续绿灯自动验证「是否解决」**、复发自动 reopen

## 目录规划

P0 落骨架；规划树见 `../docs/设计方案.md` §3（本仓：contracts/ 契约层＋fixtures/ 样本＋scripts/＋market/index.json 自建索引＋packages/ 双包）。

## 发布目标

`packages/*` → npm publish → dsh 插件市场索引条目（`dsh-plugin-market-index` 格式 1）→ 官方开发者社区收录（P8 实锚当期渠道）。
