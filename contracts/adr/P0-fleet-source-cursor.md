# ADR P0-5: FleetSource 增量签名改为游标对象

- 状态：已采纳（P0，2026-11-07）
- 决策面：`contracts/fleet-source.ts`（`fetchRuns` / `fetchErrorEntries`）
- 上游：设计 §5.1 原文签名

## 动机

设计 §5.1 写的是：

```ts
fetchRuns(since: string): Promise<FleetRun[]>
fetchErrorEntries(since: string): Promise<ErrorEntry[]>
```

实装前发现三处缺口：

1. **适配器异构**。三个源的增量边界形态不同：hermes 是 sqlite 自增 `id`，errors.log 是字节偏移（且要跨轮转），GitCode/GitHub 是 ETag。统一的 `since: string` 逼迫适配器互猜编码。
2. **游标必须能持久化**。`workbench_cursors` 域（设计 §8）要求「`<sourceId>:<stream>` → 增量游标」，返回新游标是取数的一部分，否则调用方要再问一次「这次到哪了」。
3. **取消语义**。P5 的退避/超时逻辑需要 `AbortSignal` 才能不阻塞其他源。

## 变更面

```ts
fetchRuns(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ runs: FleetRun[]; cursor: SinceCursor }>
fetchErrorEntries(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }>
```

`SinceCursor = { token: string }`（适配器自定义编码：sqlite id / 字节偏移 / ETag），首次取数传 `null`。`ErrorEntry.raw` 携带原始定位（行 id、日志路径+偏移），便于 P6 回溯。

## 受影响 plan

- **P5**：适配器实现此签名；`workbench_cursors` 直接存 `cursor.token`。
- **P6**：错误流水线消费 `{entries, cursor}`，不复用 `since` 字符串。
- **设计文档**：§5.1 的签名注释需按本 ADR 修订（本批未改共享热文件 `docs/设计方案.md`，登记于 P0 报告挂账项，归拢窗一次性并入）。
