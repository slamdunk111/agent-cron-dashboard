# ADR P0-2: 存储域名与设计 §8 点分键空间的映射

- 状态：已采纳（P0，2026-11-07）
- 决策面：`packages/agent-cron-dashboard/src/index.ts`（`DOMAINS`）

## 动机

设计 §8 用点分域名（`workbench.snapshot.pr`、`workbench.fleet.errors` …）描述键空间，直观且与工具参数对应。实测 dsh 0.2.2-rc.1 的 `defineDomain` 要求域名匹配 `^[a-z][a-z0-9_]*$`，点号域名在模块加载时直接抛错（P0 实跑：`domain name 'workbench.snapshot.pr' must match /^[a-z][a-z0-9_]*$/`）。

## 变更面

| 设计 §8 键空间 | 实装域名 |
|---|---|
| `workbench.snapshot.pr` | `workbench_snapshot_pr` |
| `workbench.snapshot.issue` | `workbench_snapshot_issue` |
| `workbench.fleet.jobs` | `workbench_fleet_jobs` |
| `workbench.fleet.errors` | `workbench_fleet_errors` |
| `workbench.fingerprints` | `workbench_fingerprints` |
| `workbench.cursors` | `workbench_cursors` |
| （P5 健康面，设计 §5.3） | `workbench_fleet_health` |

键（key）仍按设计 §8：`<platform>/<o>/<r>/<n>`、`<sourceId>/<jobId>`、`<recordId>`、`<signature>`、`<sourceId>:<stream>`。设计文档中的点分写法继续作为**逻辑名**出现在注释与工具输出里，存储层用下划线名。

## 受影响 plan

- P2/P3/P4/P5/P6/P7：写存储时一律用 `DOMAINS` 导出的 spec（或 `workbench_snapshot_pr` 等实装域名），不得再造点分名。
