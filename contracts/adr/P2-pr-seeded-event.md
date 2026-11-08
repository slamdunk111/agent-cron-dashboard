# ADR P2-1: `pr-seeded` kind and `SnapshotPair`

- 状态：采纳（P2 批次；随笔 1 提交）
- 日期：2026-11-08
- 决策人：P2 实施会话（外审 R1–R35 收敛后由 owner 定）

## 动机

母纲 P2 任务 3 要求「快照写 `workbench.snapshot.pr`（事件环形 50 条），首见记 `seeded` 不通知」，任务 4 要求
「listener 产出快照对推事件总线键（P4 未在席时落库暂存）」。两件事都需要契约里**没有**的东西：

1. `ChangeKind` 联合里没有首见语义的 kind。community 层自造字符串会让 P4 的分级表
   （`CHANGE_LEVELS` 是 `Readonly<Record<ChangeKind, ChangeLevel>>`，要求全键覆盖）在编译期失败。
2. 「快照对」没有类型。它在 P2 产出、P4 消费，属跨 plan 共享面，按母纲 §6 必须冻结在 `contracts/`。

## 变更面（只增不改）

1. `contracts/events.ts`：`CommunityChangeKind` 增 `'pr-seeded'`；`CHANGE_LEVELS` 增 `'pr-seeded': 'medium'`。
2. `contracts/events.ts` 末尾新增 `export interface SnapshotPair<T = unknown> {key, before, after, at}`。
3. 既有类型与分级**一字未改**；`PrSnapshot`/`IssueSnapshot`/`SourceHealth` 形状零变化。

## 语义

- **产出方是 P4**（`events.ts` 文件头注释：`ChangeEngine` (P4) turns snapshot pairs into `ChangeEvent`s）。
  P2 `PRWatchService` 只写快照与快照对：首见对是 `SnapshotPair{before:null, after:<snapshot>, at}`。
- `level = 'medium'`，且 **P4 不派发**（首见不通知）；即使误派发也只会进摘要，不会进 action card。
- 每键一次：P4 只在 `before === null` 时造该 kind；P2 只在本进程首次见到该键（落库无快照）时推 `before: null`。
- `PrSnapshot.events` 环：P2 写首见快照时置空数组，由 P4 回写。

## 受影响 plan

| plan | 影响 |
|---|---|
| P4 | 分级表/去抖表须含 `pr-seeded`；不得将其与后续事件合并；`SnapshotPair` 是它唯一的输入类型 |
| P7 | 事件时间线文案须有 `pr-seeded`（「首次观测」/「first observed」） |
| P3 | Issue 侧是否复用本 kind 或另立 `issue-seeded`，由 P3 自行立 ADR |

## 备选方案

- **A（本 ADR）**：契约增 kind 与快照对类型。
- **B**：只写 `firstSeenAt` 不产生事件——P4 无法区分「首见」与「无变化」，且不合 plan 原文。
- **C**：community 自造事件对象——类型系统不允许，违反 `events.ts` 的分层注释。
