# ADR P2-2: GitCode capability table as a contract constant

- 状态：采纳（P2 批次；随笔 1 提交）
- 日期：2026-11-08
- 决策人：P2 实施会话

## 动机

P2 的 watch 服务与 P7 的按钮禁用都要知道「GitCode provider 现在能不能做某事」（写操作是否可用、
`fetchChecks` 是否可用）。上游 `ForgeProvider` 类型**没有** `capabilities()`（实测
`dsh-experimental-forge/lib/types` 无该方法）；`contracts/forge-provider.ts` 里的
`ProviderCapability` 只是工作区的投影，P1 的 `index.ts` 以函数体返回 13 项表。

三个消费方（P2/P7/未来的 P8 文档）如果各自抄一张表，必然漂移。跨包共享面按母纲 §6 只能落在
`contracts/`，因此把表冻结成一等常量，而不是让消费方读 P1 源码。

## 变更面（新增文件，不改既有契约）

`contracts/gitcode-capabilities.ts` 导出 `GITCODE_CAPABILITIES: readonly ProviderCapability[]`
（类型复用 `contracts/forge-provider.ts` 的 `ProviderCapability`），内容照
`docs/gitcode-v5-diff.md` §3 的能力结论：13 项，其中 `fetchChecks`/`markReady`/`merge`/`submitReview`
四项 `implemented:false`（`note` 写依据，逐字取自差异表）。

## 与 P1 的关系

P1 的 `capabilities()` 仍是 provider 的实现面；本常量是**同一张表的契约副本**。
P2 单测断言两者逐项一致（`implemented` 与 `note` 逐字相等），漂移即红。

## 受影响 plan

| plan | 影响 |
|---|---|
| P1 | 无需改代码；单测新增一致性断言 |
| P2 | `WorkbenchService.providerCapabilities` 读本常量，经 `ctx.forge.readiness` 判定行在席 |
| P7 | 按钮禁用文案读 `capabilityNotes()`，底层同一常量 |
| P8 | README「已知限制」直接引用本常量 |
