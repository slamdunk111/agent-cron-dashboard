# ADR P0-6: 行内读 `storageDomain` 走 `ctx.get`，`inject` 声明保留

- 状态：已采纳（P0，2026-11-07）
- 决策面：`packages/agent-cron-dashboard/src/index.ts`（`inject`、`WorkbenchService.openDomains`）
- 探针：`test/inject-probe.test.ts`、`test/row-apply.test.ts`

## 动机

`storageDomain` 形态由 `@deepseek-ai/dsh-storage-domain` 在 `apply` 里 `ctx.storage.mount('domain', facility)` + `provide('storageDomain', facility)` 挂出；第三方 bundle 只能 `defineDomain` + `open`，**没有**注册表 API（外部核查：`DomainFacility` 仅有 `open/get/closeAll`）。

实测两种取法的差异：

| 取法 | 结果 |
|---|---|
| `ctx.storageDomain`（裸读，**未**声明 `inject` 的服务） | 抛 `cannot get property "storageDomain" without inject`（cordis 代理守卫；实测见 `test/inject-probe.test.ts` 的裸读用例） |
| `ctx.storageDomain`（裸读，服务已声明 `inject: ['storageDomain']`） | 在改版脚本的探针里曾抛同一错误——`ctx.plugin` 起的 fiber 上 `inject` 声明**不保证**代理放行 |
| `ctx.get('storageDomain')` | 在 composer 与裸 `Context` 下都取到真正的 facility（`test/inject-probe.test.ts` / `row-apply.test.ts` 实跑） |

同时，`inject = ['storageDomain']` 是 dsh 侧插件检查（等待所需服务）所需，**保留**。

## 变更面

1. `openDomains()` 通过 `this.ctx.get('storageDomain')` 取 facility，未挂载时报 `workbench: storageDomain facility is not mounted in this profile`。
2. `export const inject = ['storageDomain']` 保留，注释指向本 ADR。
3. 已开域名跳过重复 `open`（facility 对同名域是 single-open，重复 open 抛 `already-open`）。
4. 开域失败进入重试（每秒一次，直到成功或行卸载）；行卸载时置 `disposed`、`clearInterval`、**等待所有在途开域结束**后再关闭所持全部域（`test/row-apply.test.ts` 的卸载用例与 `test/row-dispose-race.test.ts` 锁定）。

## 受影响 plan

- P2-P7：新增服务一律先 `ctx.get` 再裸读；行内自开域一律沿用本形态。

## 备注（P3-03 登记）

契约里的 `query` 只约束语句形态（单条 SELECT、无双语句）。SQLite 的 `SELECT` 仍可调用有副作用的函数（`writefile`、`load_extension` 等），**P5 实现 ssh-sqlite 适配器时必须用只读方式打开库**（`sqlite3 -json 'file:…?mode=ro'` 或等价 `-readonly`），不得仅依赖语句检查。
