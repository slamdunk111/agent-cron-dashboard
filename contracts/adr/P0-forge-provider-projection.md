# ADR P0-1: forge provider 契约以「冻结投影」形式落 contracts/

- 状态：已采纳（P0，2026-11-07）
- 决策面：`contracts/forge-provider.ts`

## 动机

`@deepseek-ai/dsh-experimental-forge` 处于实验层（0.2.2-rc.1），其 `types.d.ts` 明确标注实验，接口随时可能改名。若下游 P2/P7 直接 `import type` 上游类型，一次上游改名会同时打断整个工作区；若我们什么都不冻结，每个 plan 又会各自猜接口。

## 变更面

1. `contracts/forge-provider.ts` 手工投影上游 `ForgeProvider` 的工作区子集（仓库/变更请求引用、快照、失败、readiness），并追加 dsh 侧没有的显式能力表 `ProviderCapability`（用于「声明不支持」留证）。
2. 投影**不是 re-export**：投影文件零依赖，任何包都可 import。
3. 同步程序：升级 dsh 时对照 `@deepseek-ai/dsh-experimental-forge/lib/types/types.d.ts` 逐字段核对，差异只改本文件与 P1 一个包（`packages/dsh-forge-gitcode`）。

## 受影响 plan

- P1（实现方，唯一直接接触上游类型的地方）
- P2（消费方，只依赖投影）
- P7（UI 读快照，只依赖投影）

## 备注

`$defs.analysisOutput`（`contracts/config.schema.json`，P6 的 LLM 输出约束）目前只有 schema，没有 TS 校验器与语料；由 P6 落地并补测，本批仅登记。
