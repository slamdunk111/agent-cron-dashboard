# ADR P5-1：Fleet 适配器实锚与契约增量

- 批次：P5（Fleet 适配器）｜日期：2026-11-08
- 动机：三适配器按实机探测落地；探测结论与既有假设有四处冲突，另需给通用适配器补三个可选查询键。
- 来源：`../docs/probes/hermes.md`（2026-11-08 实跑）、`../docs/probes/jiuwenswarm.md`（同日实跑）。

## 变更面

| # | 变更 | 文件 |
|---|---|---|
| 1 | 新增可选键 `fleet[].ssh.runsQuery` / `jobsQuery` / `errorsQuery`，三个都 `$ref: #/$defs/readOnlyQuery`（与既有 `query` 同约束：单条 SELECT、禁第二语句） | `contracts/config.schema.json`＋`contracts/config-validate.ts`＋生成拷贝 `packages/agent-cron-dashboard/src/config-validate.ts` |
| 2 | 无其它契约改动：`FleetSource`、`FleetJob`、`FleetRun`、`ErrorEntry`、`SourceHealth`、`SinceCursor`、`CursorRecord`、`CHANGE_LEVELS` 全部原样 | — |

## 实锚修正（探测推翻了什么）

1. **hermes job 定义不在 SQLite 表**：实测在 `/root/.hermes/cron/jobs.json`（39 条，`{jobs:[…],updated_at}`）。适配器用 `tail -c` 整读该文件并解析，不新增 SQL。设计 §5.2 只写「探测子任务锚定」，未指定落点，故本项不算契约变更。
2. **`cron_run_events.status` 全表 NULL**（1723＋1543＋99 行全 null）：运行状态改由 `event_type` 组合推导（同 `job_id`＋同 `occurred_at` 出现 `script_error` ⇒ failed）。SQL 仍选 `status` 列（不改查询面），列值在 `exitDetail` 旁显名 `statusColumnNull`。
3. **`cron_run_metrics` 只有三枚举**（`check_runs_total`/`delivery_suppressed_total`/`script_errors_total`，无成功计数、无自增 id）：只做全量快照，不做增量；成功率由 `cron_run_events` 推导。
4. **jiuwenswarm 任务清单不是 `cron_prompts/`**：实测源码 `git grep cron_prompts HEAD` 0 命中，真相源是 `agent/home/cron_jobs.json`（34 条）；运行账本 `agent/.checkpoint/cron_run_ledger.db`（260 行全 `finished`）；错误落 `logs/tool.log`＋`run/worker-logs/*.stderr.log`。
5. **P5 不产 `error-record-*` 三键**：`error-record-opened`/`error-record-reopened`/`error-record-verified` 属 P6 `ErrorPipeline`；P5 只产 `run-failed`/`run-recovered`/`source-health-down`/`source-health-recovered`。P5 源码对这三键零引用（单测静态断言）。

## 受影响 plan

- **P6**（错误闭环）：`error-record-*` 三键由 P6 产出；P5 已把错误流以 `ErrorEntry` 形态（`sourceId/jobId/occurredAt/severity/message/raw`）交到 `fetchErrorEntries`，P6 直接消费，不需新增契约。
- **P7**（UI）：`workbench_fleet_jobs`、`workbench_fleet_health`、`workbench_events`（fleet scope）三处数据面形状与 `contracts/records.ts` 一致，无变化；health 卡读 `workbench_fleet_health`。
- **P8**：配置样例中的通用源可带 `runsQuery` 等三键，`schema` 已接受。
