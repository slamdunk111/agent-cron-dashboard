# ADR P0-6: 行内读 `storageDomain` 走 `ctx.get`，`inject` 声明保留

- 状态：已采纳（P0，2026-11-07）
- 决策面：`packages/agent-cron-dashboard/src/index.ts`（`inject`、`WorkbenchService.openDomains`）
- 探针：`test/inject-probe.test.ts`、`test/row-apply.test.ts`

## 动机

`storageDomain` 形态由 `@deepseek-ai/dsh-storage-domain` 在 `apply` 里 `ctx.storage.mount('domain', facility)` + `provide('storageDomain', facility)` 挂出；第三方 bundle 只能 `defineDomain` + `open`，**没有**注册表 API（外部核查：`DomainFacility` 仅有 `open/get/closeAll`）。

实测两种取法的差异：

| 取法 | 结果 |
|---|---|
| `ctx.storageDomain`（裸读） | 在服务构造器里、或经 `ctx.plugin(ServiceClass)` 起 fiber 时抛 `cannot get property "storageDomain" without inject`（即使 `inject` 已声明） |
| `ctx.get('storageDomain')` | 在 composer 与裸 `Context` 下都取到真正的 facility（`test/inject-probe.test.ts`） |

同时，`inject = ['storageDomain']` 是 dsh 侧插件检查（等待所需服务）所需，**保留**。

## 变更面

1. `openDomains()` 通过 `this.ctx.get('storageDomain')` 取 facility，未挂载时报 `workbench: storageDomain facility is not mounted in this profile`。
2. `export const inject = ['storageDomain']` 保留，注释指向本 ADR。
3. 已开域名跳过重复 `open`（facility 对同名域是 single-open，重复 open 抛 `already-open`）。
4. 开域失败进入重试（最长 20 次、1 秒间隔）；行卸载时置 `disposed`、`clearInterval`、关闭已开域（`test/row-apply.test.ts` 锁定）。

## 受影响 plan

- P2-P7：新增服务一律先 `ctx.get` 再裸读；行内自开域一律沿用本形态。
