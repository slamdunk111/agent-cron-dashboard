# ADR P4-1：变更引擎的契约增量（事件日志域与通知配置键）

- 状态：已采纳（P4 实施批，2026-11-08）
- 关联：`contracts/adr/P2-pr-seeded-event.md`（首见对模式）、`contracts/adr/P3-issue-polling.md`（`issue-seeded`）
- 受影响 plan：P4（本批）、P5（fleet 事件写入同一日志域）、P6（错误记录事件）、P7（UI 读事件日志）、P8（发布说明）

## 1. 动机

母纲 §6 要求「任何 plan 改契约 → 本 plan 内写 ADR」。P4 是 `events.ts` 的**第一消费者**，落地时有三处必须动契约面，否则无法完成母纲 P4 的四项任务与子计划的三条验收门：

1. **事件日志域**：母纲 P4 任务 2 要求「全量事件落 `workbench.events` 域（UI/摘要/工具的数据面）」。P0 声明的七个域里没有它，且域句柄无法在运行期新建。
2. **摘要任务的时区**：`dsh-schedule` 的 `cron` 计时**必须**带显式 `time_zone`（`lib/types/types.d.ts` `CronInput`），而 P0 冻结的 `notify.digest` 只有 `enabled`/`cron`。不增键就无法创建任务。
3. **摘要任务的点名**：`schedule` 没有标签机制，卸载/禁用时要精确删除只能按**标题**找；标题必须可配置（多 profile 时避免同名互删）。

另外两个键是母纲 P4 任务 1 与子计划验收门「去抖」「离线积压聚合」的定量入口：默认值即母纲口径（5 min、聚合为一张），无配置时行为与母纲一致。

## 2. 变更面（只增不改）

| 文件 | 变更 | 兼容性 |
|---|---|---|
| `packages/agent-cron-dashboard/src/index.ts` | 新增域 `workbench_events`（`version 1`，`layout: per-record`，表 `events`，值＝`contracts/events.ts` 的 `ChangeEvent`），插在 `DOMAINS` 首位 | 八域；既有七域名/版本/表名不动；三个域计数断言 7→8 随之更新 |
| `contracts/config.schema.json`＋`contracts/config-validate.ts` | `notify.debounceMs`（integer 0..3 600 000，默认 300 000）、`notify.backlogMergeCount`（integer 1..100，默认 2）、`notify.digest.timeZone`（IANA，默认 `Asia/Shanghai`）、`notify.digest.taskTitle`（1..120 字符，默认 `workbench-digest`） | 全部带默认值：既有配置语料（P0 正例/负例 38＋35 例）零改动即通过 |
| `contracts/events.ts` / `contracts/records.ts` | **不改** | 22 键、`SnapshotPair`、`PrSnapshot`/`IssueSnapshot` 一字未动 |

`packages/agent-cron-dashboard/src/config-validate.ts` 是生成拷贝，由 `node scripts/sync-contracts.mjs` 重生成；G3 以 `--check` rc=0 证明重冻完成。

## 3. 语义

- **事件日志键** `<at>|<subjectKey>|<kind>|<n>`：四段键让「同一时刻、同一主体、同一 kind」的两条事件也唯一，且域列表按 `at` 自然有序（P7 时间线直接读）。
- **环回写**：`PrSnapshot.events`/`IssueSnapshot.events` 的注释是「Ring buffer (max 50, newest last) of graded events」，ADR P2-1 写明「由 P4 回写」；本批按 50 条截尾。
- **首见不派发**：`pr-seeded`/`issue-seeded` 由 `before === null` 的对产生，级别按冻结表 `medium`，派发器显式跳过（ADR P2-1「不得与后续事件合并」→ 合并窗排除两键）。
- **队列只读**：P4 消费只调 P2/P3 的 `drainQueue(key)`（只清 `pairs`），`dropped`/`applied`/`nextSeq`/`pending`/`lastApplied` 原样保留；`dropped>0` 只用于显名，不回写、不重排（批约束 2）。

## 4. 备选方案

- **B**：把事件日志塞进既有 `workbench_cursors`——会与游标记录混键，且 `CursorRecord` 形状容不下 `ChangeEvent`。
- **C**：`digest.timeZone` 不增键、写死 `Asia/Shanghai`——非本机时区部署会静默跑错时间，且违反「配置可配」的母纲 D4 决策。
- **D**：`taskTitle` 不增键、由代码拼标题——受限 120 字符且无命名空间，两 profile 装同一插件时会互删任务。
