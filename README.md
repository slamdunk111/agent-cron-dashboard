# agent-cron-dashboard

dsh（DeepSeek Harness）个人工作台插件——跨社区 PR/Issue 监控＋定时任务（cron/fleet）监控，带错误分析与解决追踪。

状态：**P0 骨架与契约冻结完成（2026-11-07）**｜设计与计划见仓外 `../docs/设计方案.md`、`../plan-of-plans/母纲.md`｜交接记录 `../docs/handoff/P0.md`。

## 两个发布包

| 包 | 角色 | 现状 |
|---|---|---|
| `packages/dsh-forge-gitcode` | GitCode（api/v5）的 forge provider——PR/MR 状态、检查、可合并性接入 `ctx.forge` | P0 骨架，P1 实现 |
| `packages/agent-cron-dashboard` | 主 bundle——host 服务（配置/存储域/后续采集与分析）＋Web 工作台页＋agent 工具 | P0 骨架，P2-P7 逐节填 |

## 开发

```bash
# 依赖（本机无全局 pnpm：用 corepack）
corepack pnpm install

pnpm test                     # vitest：契约/配置语料/存储域名
pnpm build                    # TS -> build/packages/<name>/（dsh 加载器只吃纯 JS，见 contracts/adr/P0-3）
pnpm sync:contracts           # 契约改后同步包内副本（ADR P0-4）
node scripts/probe-domains.mjs    # 七个存储域在真实 json 后端上开域并读写回来
bash scripts/smoke-p0.sh         # 全量冒烟，输出落 ../docs/handoff/smoke-p0.log
```

装进开发 profile（`dsh-workbench-dev`，基于 web 模板）：

```bash
dsh --profile dsh-workbench-dev --from-default-profile web     # 初始化
dsh plugin --profile dsh-workbench-dev add build/packages/agent-cron-dashboard
dsh plugin --profile dsh-workbench-dev add build/packages/dsh-forge-gitcode
dsh --profile dsh-workbench-dev --dump-config                  # 确认 workbench / forge-gitcode 两行在席
```

## 契约与目录

```
contracts/           冻结契约：fleet-source / events / records / forge-provider + config.schema.json + adr/
fixtures/            真实样本与测试语料（config-cases.json）
scripts/             build / sync / probe / smoke
packages/            两个发布包（TS 源码，pnpm build 产出纯 JS）
test/                vitest 用例
```

跨 plan 只依赖 `contracts/`；改契约必须写 `contracts/adr/P<N>-<slug>.md`（母纲 §6）。
