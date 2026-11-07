# ADR P0-4: 主包自带契约校验器副本（sync-contracts 生成）

- 状态：已采纳（P0，2026-11-07）
- 决策面：`packages/agent-cron-dashboard/src/config-validate.ts`、`scripts/sync-contracts.mjs`

## 动机

契约层 `contracts/` 位于发布仓根，各包源码用 `../../../contracts/...` 引用。实测 dsh 0.2.2-rc.1 的 `plugin_manager install_bundle`（宿主侧 `pnpm add <目录>`）会把链接目录**复制**进 profile 的 `node_modules`，包外的相对路径随即失效；发布到 npm 时包本身也不含 `contracts/`。而检测器必须在装载后真实运行（行激活时校验配置）。

## 变更面

| 契约 | 包内形态 |
|---|---|
| `contracts/config-validate.ts` | `packages/agent-cron-dashboard/src/config-validate.ts`（生成副本，文件头标注 GENERATED COPY） |
| `contracts/config.schema.json` | 不复制：作为规格文档由 `scripts/validate-config.mjs`（Ajv 2020-12）与 `test/config-corpus.test.ts` 读取 |
| 其余 `contracts/*.ts` | 不复制：类型由 esbuild 在构建时擦除；**运行时值**（主包用到的 `CHANGE_LEVELS`）由 esbuild 内联进构建产物。源码树仍以包外相对路径引用 `contracts/events.ts`、`contracts/records.ts`，但发布与安装一律以构建产物 `build/packages/<name>/` 为准 |

同步命令：`pnpm sync:contracts`（写）；`node scripts/sync-contracts.mjs --check`（校验是否漂移，已接入 `scripts/smoke-p0.sh` 步骤 1b 作为验收门的一部分）。

## 受影响 plan

- P1..P7：需要运行时校验/类型时，从 `contracts/` 改，然后跑 `pnpm sync:contracts`；禁直接改副本。

## 备注：forge 包的 tokenEnv 规则副本

`packages/dsh-forge-gitcode/src/index.ts` 因同一原因（安装时复制包目录、包外相对路径不可达）保留了一份 `TOKEN_ENV_RE`（3..128 大写名字）。它是契约规则的**第二处实现**，两处必须同步修改；主包用生成副本、forge 包用手写副本，`pnpm sync:contracts --check` 只覆盖主包那份。若将来把 forge 包改为依赖主包，可收敛为一处。
