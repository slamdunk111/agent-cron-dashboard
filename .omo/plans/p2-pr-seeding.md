---
title: agent-cron-dashboard P2 PR 播种与 watch 接线 实施计划 v11
type: code-dev
status: review
owner_review: pending
---

# P2 实施计划（PR 播种与 watch 接线）

> 批次：agent-cron-dashboard P2｜日期：2026-11-08｜**v11**（唯一正典版；v1–v10 全部作废，本文件由零重写，不保留任何旧版段落）
> 落盘：正典＝`agent-cron-dashboard/.omo/plans/p2-pr-seeding.md`（本文件）；`../docs/handoff/P2-实施计划.md`＝去 frontmatter 的逐字镜像，**由 `scripts/p2-mirror-check.mjs`（**笔 6** 交付）比对两边正文 sha256 并把值写进报告**。
> 基线：`main` HEAD `4411250`；worktree 仅 3 个未跟踪 fixtures（零源码改动）。本批至今未改任何源码。

## 0. 外审历史

| 轮 | 引擎 | 结论 | 主要判词 |
|---|---|---|---|
| R1 | dsh headless | REJECT | 证据不可复算、偏离未显名、越界造事件、fail-open |
| R2 | droid haiku 5-5 `-r high` | REJECT | 链式门绕播种、队列未落库、映射把 mergeable_state 当 CI、`head=` 无来源、规则 0 落点 |
| R3 | droid haiku 5-5 `-r high` | REJECT | 能力旁路跨包、`head=` 复核空转、门无 oracle、无令牌整仓 watch、`SnapshotPair` 未入契约 |
| R4 | opencode spark-x2.6 | 无判词 | 引擎工具循环卡死，该轮作废 |
| R5 | opencode spark-x2.6 | REJECT | 正文 §3.6 起缺失、readiness 参数两版相反、旧文反向 |
| R6 | opencode spark-x2.6 | REJECT | canary 自相矛盾、checksRollup 优先级、§9.2 对账、日期错位、TRF 口径 |
| R7 | droid haiku 5-5 `-r high` | REJECT | oracle 不可判、无令牌门证据链、validator 复跑对象、首见写入顺序、命令与 gate |
| R8 | droid haiku 5-5 `-r high` | REJECT | 门①不同源、无令牌门空真、旗标与脚本未定义、python 版本/commit 门、首见幂等 |
| R9 | droid haiku 5-5 `-r high` | REJECT | 门①仍不同源、GitHub 由谁 watch 未定义、脚本旗标互异、未显名偏离 |
| R10 | droid haiku 5-5 `-r high` | REJECT | 门①硬编码集合仍在、`WatchSource` 未落正文、`***` 空真、PR 上限三值、状态映射未穷举 |
| R11 | droid haiku 5-5 `-r high` | REJECT | oracle 非独立、首见失败分支、轮次门槛不可达、状态码未穷举、canary 空真 |
| R12 | droid haiku 5-5 `-r high` | REJECT | oracle 仍"逐字一致"残留、首见对可丢、门②两态互斥、阈值 180/150 不一致、artifacts 未列 |
| R13 | droid haiku 5-5 `-r high` | REJECT | 阈值残留、崩溃窗口丢首见、canary 空真、证据来源不符、覆盖率非二值、交付物漏列 |
| R14 | droid haiku 5-5 `-r high` | REJECT | 轮次门槛不可达、首见崩溃窗口、E2E-1 前置与命令矛盾、证据不可复算、门②证据链 |
| R15 | droid haiku 5-5 `-r high` | REJECT | 覆盖率无机器源、GitHub 门槛无实测、E2E-1 与 §5.1 不一致、§9.2 不同源、首见顺序与队列满冲突 |
| R16 | droid haiku 5-5 `-r high` | REJECT | 计数单位、页数规则两端互斥、状态机不闭合、GitHub 过滤无定义、证据路径不可判 |
| R17 | droid haiku 5-5 `-r high` | REJECT | 计数口径、页数规则、原子记录、GitHub 过滤、artifact |
| R18 | droid haiku 5-5 `-r high` | REJECT | 计数键/门槛、状态机不变式、翻页与过滤两套、交付表漏列、门③非二值 |
| R19 | droid haiku 5-5 `-r high` | REJECT | 门编号混用、门槛算术、rc 与伪 shell、log 冲突、队列满与判重 |
| R20 | droid haiku 5-5 `-r high` | REJECT | G1 混入 G2 断言、门槛算术、pipefail、log 冲突、容量策略缺失 |
| R21 | droid haiku 5-5 `-r high` | REJECT | G1 仍含 G2 断言、log 路径不一致、判定脚本未入交付、容量/判重未定稿、round# 口径 |
| R22 | droid haiku 5-5 `-r high` | REJECT | 容量策略引用不存在条款、count/阈值、G3 链、覆盖率数据源、E2E 命令 |
| R23 | droid haiku 5-5 `-r high` | REJECT | 双 tee、降级断言格式、G3 二值、artifact |
| R24 | droid haiku 5-5 `-r high` | REJECT | 容量表与声明矛盾、G2 行格式、G3 链、旗标、镜像未列 |
| R25 | droid haiku 5-5 `-r high` | REJECT | 恢复臂双写法、G3 只 tee 末段、GitCode 映射未定义、豁免自证、no-token 两机制 |
| R26 | droid haiku 5-5 `-r high` | REJECT | 恢复臂矛盾、log 链、watch 映射、豁免不独立、no-token 来源两写法 |
| R27 | droid haiku 5-5 `-r high` | REJECT | 同上残留 + 计数稀释 |
| R28 | droid haiku 5-5 `-r high` | REJECT | no-token 源、字段不全、基线自证、门槛不可判伪 |
| R29 | droid haiku 5-5 `-r high` | REJECT | ***无来源、丢弃路径缺第三条、基线步骤、EXIT rc 与镜像门、未知 conclusion |

v11 逐条对应：**门①**＝§3.2 与 §5.1 同一 `state=open`、同页数、同过滤；oracle 由脚本动态生成（硬编码集合只作历史读数，不是判据）。**GitHub 接线**＝§3.3 定义 `WatchSource` 接口，GitHub 侧由本批 `GithubProvider` 实现并自带轮询。**无令牌门**＝§5.2（唯一机制见 §5.4 的 `--no-token` 行）。**PR 上限**＝§3.6 唯一数字 10。**状态映射**＝§3.6 穷举所有取值。**队列**＝§3.4 全分支。

## 1. 目标、范围与交付物

| 文件（`packages/agent-cron-dashboard/src/community/`） | 职责 | 笔 |
|---|---|---|
| `identity.ts` | IdentityService：GitHub 登录（配置优先，缺省 `gh api user`）；GitCode `GET /api/v5/user` 校验令牌归属（D5 三态）；写 `workbench_cursors`；产 health；日志经 `redact()` | 2 |
| `github.ts` | `GithubProvider`：`gh api` 直读 GitHub PR → forge 形状快照；实现 `WatchSource`（自带 60s 轮询、退避、merged 停）；**不注册 `ctx.forge`**（D4） | 3 |
| `seeding.ts` | SeedingService：`listOpenAuthored`（与 oracle 同源）→ watch 集；写 `seed:<platform>` 游标；24h 刷新 | 4 |
| `pr-watch.ts` | PRWatchService：`WatchSource.subscribe` → `PrSnapshot` → 落库队列 `SnapshotPair`（§3.4） | 5 |
| `contracts/gitcode-capabilities.ts` | 能力表常量（照 P1 差异表 §3 能力矩阵，四项声明不支持）＋ADR P2-2 | 1 |
| `contracts/events.ts`（追加） | `SnapshotPair<T>`＋`pr-seeded` kind（ADR P2-1；**P2 就加键的理由**：P2 产出的 `before:null` 对在 P4 接线前若没有该 kind，P4 首轮消费时会因 `CHANGE_LEVELS` 缺键而编译期失败；键由 P4 产出，P2 只消费键名） | 1 |
| `src/index.ts`（接线） | `WorkbenchService` 三个只读属性：`providerCapabilities`／`writeCapabilities`／`capabilityNotes()` | 5 |
| `scripts/probe-forge-context.mjs` | 实锚：`ctx.get('forge')`、同家族二次注册、watch 存活 | 3 |
| `scripts/p2-oracle.mjs` | **独立** oracle（不引用 `seeding.ts` 函数）＋三种模式 `--mode oracle|probe-perpage|mitm-none` | 6 |
| `fixtures/p2-smoke-config.yaml` | 真机 run 的配置：`identities`（github `username: slamdunk111`、gitcode `username: nawenyu139` `tokenEnv: GITCODE_TOKEN`）＋`watch.repos[]`＝`https://github.com/dptech-corp/Uni-Core`、`https://gitcode.com/openJiuwen/jiuwenswarm` | 6 |
| `scripts/smoke-p2.mjs` | 真机链式冒烟，旗标见 §5.4 | 6 |
| `scripts/p2-mirror-check.mjs` | 正典与镜像正文 sha256 比对（**笔 6**；G3 #5 执行器；镜像文件 `../docs/handoff/P2-实施计划.md` 也在笔 6 首次落地） | 6 |
| `scripts/p2-coverage-gate.mjs` | 覆盖率二值门：`src/community/**` 的 `lcov` 未覆盖行数必须为 0（§5.10，无豁免清单）（笔 6） | 6 |
| `scripts/p2-gate-check.mjs` | G1/G2/G3 的断言执行器（读 log、按 §5.1/§5.2 的断言表判定，rc=0 即通过）（笔 6） | 6 |
| `scripts/p2-baseline-record.mjs` | 笔 0 交付：把 vitest 原始日志转成结构化基线文件（笔 0 先写此脚本再接笔 1） | 0 |
| `scripts/test-count.mjs` | P0 既有脚本，本批复用（产物进 `p2-g3.log`） | 复用 |
| `scripts/fixtures-capture.mjs` | 抓取 fixtures 固定样本（笔 1，`--repo/--pr`） | 1 |
| `fixtures/{github,gitcode}/*` | 新增 5 件（pull-75、pulls-head、status-uni-core-75、pulls-mine-all-p1、pull-9722）；user-anon-403 为 P1 既有 | 1 |
| `test/community-{identity,seeding,pr-watch,github-adapter}.test.ts` | 单测（§7） | 2–5 各随笔 |
| `test/contracts.test.ts`（改动） | 20→21 键断言 | 1 |
| `contracts/adr/P2-pr-seeded-event.md`、`contracts/adr/P2-gitcode-capabilities.md` | 契约 ADR | 1 |
| `../docs/handoff/P2.md`、`P2-实施总结与质量报告.md`、`../docs/handoff/P2-实施计划.md`（镜像，笔 6 首次落地、笔 7 最终同步）、`p1-test-count.txt`（基线，笔 0 生成） | 交接、报告、镜像、基线 | 7 |
| 运行产物 `../docs/handoff/p2-g1.log`、`p2-g2.log`、`p2-g3.log`、`p2-oracle-github.json`、`p2-oracle-gitcode.json` | G1/G2/G3 证据 | 6 |

**不做**（进 §4 裁定清单）：Issue 播种/轮询（D6，P3）；事件分级与通知（P4）；UI（P7）；GitCode 写操作。

## 2. 输入锚点与实锚

### 2.1 锚点表

| 锚点 | 位置 | 读到什么 | 影响 |
|---|---|---|---|
| `contracts/events.ts` | 头 :5-10（事件由 P4 造、新增 kind 须 ADR）；`CommunityChangeKind` :14-27；`FleetChangeKind` :30-36；`CHANGE_LEVELS` :81-102 | `CHANGE_LEVELS` 现有键数＝20（社区 13＋舰队 7），无 `seeded` | 增 1 键，最终 21（机器断言见 §4.5） |
| `contracts/records.ts` | `PrSnapshot` :18-38；`SourceHealth` :79-91；`CursorRecord` :176-181 | 形状冻结 | 不改形状 |
| `contracts/config.schema.json` | `identity` :44-92（gitcode `username` 必填）；`watch.repos[]` :97-104 | 身份显式 | D5 |
| `contracts/forge-provider.ts` | `ForgeRepository{forge,host,owner,name}`；`ProviderCapability` | 能力表形状与 `readiness` 入参 | §3.5 |
| 上游 forge | `lib/types/index.d.ts:12-18`（`forge/providers-changed`）、`:152-172`（watch/latest/refresh）；`types.d.ts:109-118`、`:211-213` | watch 是 effect；listener 不得抛错；上游无 `capabilities()` | §3.3/§3.5 |
| P1 差异表 | :12（匿名 pulls 200）、:14（GitCode 无 Link 头）、:23（`?head=` 简形）、:49（空时间戳 `""`）、:70（匿名 `/user` 403） | 分平台分页/过滤 | §3.2 |

### 2.2 本批实跑（2026-11-08，时刻 +08:00；全部只读）

| 时刻 | 动作 | 读数 |
|---|---|---|
| 13:02:31 | curl `pulls?state=open&head=fix/history-wire-truncation-markers` | `[9723]`——**他人 PR**（`thesky58`，13:13:52 复读确认），只是证明 `head=` 过滤形态有效，**不属于**我方 oracle |
| 13:05:17 | `~/.gitcode_token` → `/api/v5/user` | `login=nawenyu139`（**令牌存在，P1 交接「本机无令牌」已过时**） |
| 13:05:37 | 列表 `state=open` 首页 50 | 本人 4 条 open：#9704 #9706 #9707 #9722 |
| 13:06:51 | 4 条详情 | 全 `ci_state_passed=true`，`updated_at` 11-07 21:41 — 11-08 09:50 |
| 13:13 | GitHub 各仓列表 | `dptech-corp/Uni-Core` 本人 open #73 #74 #75 |
| 13:25:17 | `probe-forge-context.mjs` | `ctx.get('forge')` 实现层可读；同家族二次注册**抛错**；`watch()` 首轮出快照 |
| 13:29:14 | `/user` 三种头 | 无头 **403 no scopes:read_user**；空令牌 **403**；伪令牌 **401 token not found** |
| 13:32:42 | `per_page` 3/20/50/100 | 请求 N 条实得 N 条（N∈{3,20,50,100}），即服务端不封顶 100 |
| 13:32:58 | GitHub `status`/`check-runs` | Uni-Core#75 `state=pending total_count=0`、`check-runs 0`；vllm#14240 `success total 2`、`check-runs 12`（failure/skipped/success） |
| 13:59:37–52 | `setTimeout` 内注册 watch | 3 次连续回调均出快照（存活性实测） |
| 14:19:43 | `pnpm test` | 9 文件 / **153** 例全绿（基线） |
| 15:06:50–15:07:20 | `interval.mjs`（ForgeService `{activeIntervalMs:10000,idleIntervalMs:10000}`） | 组合 8 ms；33 s 内 3 次刷新，间隔 12500/12269 ms（=10 s + 单次读取 ~2.3–2.5 s）；门槛按此公式（§5.1） |
| 13:33:25 | `fx_gh2.py` 写入 `fixtures/github/status-uni-core-75.json` | `state=pending total_count=0`、`check_runs 0`、`_sha=aeabab13…` |
| 15:15:20–15:15:37 | `ghrate.mjs`（4 次 `gh api`/轮，模拟适配器） | 单轮 8385/8736/8513 ms（均值 8.5 s）；`sleep=60 s` ⇒ 实际 68.5 s/轮，1800 s 窗口可完成 **26 轮**，门槛＝`floor(26×0.9)=23` |
| 13:22 | dev profile `node_modules` | 仅 `forge`、`workbench`(→build)、`forge-gitcode`(→build)；**无 GitHub provider 包** |

## 3. 设计与实现

### 3.1 IdentityService（`identity.ts`）

1. GitHub：配置 `username` 优先；缺省 `gh api user --jq .login`（runner 可注入）；失败 → `down`＋message。
2. GitCode：`GET https://gitcode.com/api/v5/user`＋`private-token`；令牌**只**取 `tokenEnv` 命名的环境变量；**不读** `~/.gitcode_token` 等替身文件（源码扫描单测断言）。
3. 三态：令牌属于配置用户 → `up`；令牌**缺失**（`tokenEnv` 变量不存在）→ `down`，不发请求，message 写「no token in GITCODE_TOKEN」；令牌**被拒**（变量存在、主机 401/403）→ `down`，message 带 HTTP 状态与主机原文；令牌属于他人 → `degraded`。
4. 播种过滤值（唯一规则，两处共用同一函数 `effectiveLogin(platform)`）：GitHub 取配置 `identities[].username`，**缺失时取第 1 条 `gh api user` 的 login**（`§5.4` 的 run 配置显式写 `username: slamdunk111`，因此 run 中不触发回退）；GitCode 取配置 `username`（schema 必填）。播种与 oracle 都读这个函数返回的同一值。
5. 日志：`redact(line)`＝把每个注入的 secret 值在整行内**字面替换**为 `***`（不限出现位置；空串不参与）；四个模块的唯一出口 `log(line)` 先过它；**`redact` 的 secret 列表在任何 run 都包含当前 `tokenEnv` 的真实值**（有令牌时由 `identity.ts` 读取后注入；`--no-token` 时注入替身），**`smoke-p2.mjs` 自身 stdout 也经同一个 `redact`**（secret 列表由 `--no-token` 注入），因此「整份 log 不出现 canary」覆盖全部出口。

### 3.2 SeedingService（`seeding.ts`）——字段级规范（oracle 独立实现，互不引用）

**共用常量（两端各自实现，值必须相同）**：`LIST_STATE='open'`、`LIST_PER_PAGE=50`、作者过滤＝配置 `identities[].username`；GitCode 页 1..3（短页即止），GitHub 仅页 1（`Link rel="last">1` → 该仓 `degraded` 并记 message）。

**实现约束（供双方各自执行，不共享代码）**
- 单页请求：GitHub `gh api repos/{o}/{r}/pulls?state=open&per_page=50&page=1`（与 §3.6 同一鉴权路径；oracle 与播种都用它，避免两套取数）；GitCode `GET https://gitcode.com/api/v5/repos/{o}/{r}/pulls?state=open&per_page=50&page=N`（头 `private-token: <token>`）。
- 过滤：仅保留 `user.login === 配置 username`；GitCode 另需 `merged_at` 为空串或不存在（P1 差异表 :49）、`state === 'open'`。
- 来源标：GitHub 行 `head.repo.owner.login !== {o}` → `sourceId=github:fork:<owner>`（fork 只记不丢）；GitCode 行 `sourceId=seed:gitcode`。
- 分页：GitCode 短页（`rows.length < 50`）为止；第 3 页仍满 → `degraded`「only first 150 listed」。
- 去重键 `<platform>/<owner>/<repo>/<number>`；游标 `seed:<platform>`=`JSON{at,count,keys}`；刷新=启动一次＋`setInterval(24h)`（防重入、`ctx.effect` 清理）。
- 播种跳过条件=`identity.gitcode.state !== 'up'` → GitCode 零请求、零条目、`community:seed:gitcode=degraded`（D8）。

### 3.3 PRWatchService（`pr-watch.ts`）——`WatchSource` 统一接线

```ts
interface WatchUpdate { key: string; fetchedAt: number; snapshot?: PrSnapshotLike; failure?: ForgeFailure }
interface WatchSource { subscribe(ref: {platform; owner; repo; number}, listener: (u: WatchUpdate) => void): () => void }
```

`snapshot` 的形状＝`contracts/forge-provider.ts` 的 `ChangeRequestSnapshot`（本批只读其字段）；`failure` 的形状＝同文件的 `ForgeFailure`。GitCode 分支把 `ref` 换成上游形状 `{repository:{forge:'gitcode',host:'gitcode.com',owner,name}, number}` 再调 `ctx.forge.watch`，**PR 号来自 `ref.number`**；`failed` 时给 `failure`，成功时给 `snapshot`。
- `platform === 'gitcode'` → `ctx.forge.watch(gitcodeRef, listener)`，其中 `gitcodeRef = {repository:{forge:'gitcode', host:'gitcode.com', owner:ref.owner, name:ref.repo}, number:ref.number}`（**唯一形状**；上游 `ChangeRequestRef` 无 `platform/repo` 字段）。
- `platform === 'github'` → `GithubProvider.subscribe({platform,owner,repo,number}, listener)`（§3.6），内部 60s 轮询、退避、merged 停，回调形状与 GitCode 一致（`{key, fetchedAt, snapshot | failure}`）。
- 每个 PR 在**自己的 `ctx.effect`** 内注册；`dispose()` 全撤；listener 全程 try/catch。

### 3.4 首见、变更与队列（`SnapshotPair`）——状态机与唯一的容量判定表

**键空间（`workbench_cursors`，单键 `CursorRecord.token` 存 JSON）**

| 键 | 值（字段完整集合，不再有表外字段） |
|---|---|
| `<key>:queue` | `pairs`（≤200，`[{seq,before,after,at}]`）、`dropped`、`applied`、`nextSeq`、`pending`（`null` 或 `{seq,snapshot,at}`）、`lastApplied`（`{seq,before,after}`）、`retries`；**快照记录本身的字段**＝`PrSnapshot` 的 `platform/owner/repo/number/title/state/draft/mergeability/reviewDecision/checksRollup/headSha/updatedAt/firstSeenAt/lastSeenAt/events`（「七字段 diff」＝`state/draft/mergeability/checksRollup/reviewDecision/headSha/title`，`lastSeenAt` 每次收更新时刷新） |

`put` 是单键原子写，中断只可能落在「写前/写后」。

**容量判定表（三条臂唯一遵循；`n=pairs.length`，`nonSeed`＝`pairs` 中 `before!=null` 的条数）**

| 输入 | `n<200` | `n==200` 且 `nonSeed≥1` | `n==200` 且 `nonSeed==0` |
|---|---|---|---|
| **首见对**（两臂同一格，唯一写法） | 入队 | FIFO 丢最旧非首见对（`dropped++`）后入队 | **不入队**：保留（或按需先写）`pending`、`retries++`；health `queue-full`；每轮重试，`retries≥3` 记 `degraded seed-pair-pending` 并继续重试 |
| **变更对** | 入队 | FIFO 丢最旧非首见对（`dropped++`）后入队 | **不入队**：只写快照七字段，`dropped++`，health `queue-full` |

**丢弃路径（仅三条）**：①首见对在「可腾位」格**挤掉最旧变更对**（`dropped++`）后自己入队——这是首见对**唯一**会挤掉他人的格子，被挤掉的是变更对（P4 可能漏一条变更事件，交接显名）；②变更对在「可腾位」格丢最旧变更对、在「全首见满」格丢弃本变更对（均 `dropped++`）；③首见对在「全首见满」格**不丢任何东西**，只 `retries++` 重试。首见对**从不被挤掉、也从不计入 `dropped`**。

**一轮处理**

1. `A := applied`；`seq() = nextSeq`（同一次原子写里 `nextSeq=seq+1`）。
2. **恢复臂**：`pending` 非空 → 快照缺失则回首见臂；快照已写且 `p.seq<=A` → 清 pending；快照已写且 `p.seq>A` → 按容量判定表「首见对」行执行（入队或保留 pending，二者由该行格子决定）。
3. **首见臂**：`getSnapshot()===undefined` → 按容量判定表；入队路径＝写 `pending` → 写 `PrSnapshot{events:[]}` → 写 `{pairs+=pending, applied:p.seq, pending:null}`。
4. **变更臂**：`getSnapshot()!==undefined` → 七字段 diff；无变化只更新 `lastSeenAt`；有变化 → `lastApplied` 判重（与本次 `before/after` 相同则只推进序号）→ 按容量判定表「变更对」那一行 → 入队路径＝先写队列（含新对、`applied`、`nextSeq`、`lastApplied`），成功后写快照七字段。
5. **失败臂**：读失败 → PR 级 health（§3.7），不写库。

**`drainQueue(key)`**：`pairs` 置空，`applied/nextSeq/pending/lastApplied/retries` 全部保留。

**全首见满队的终态（上界论证）**：队列里 200 条首见对意味着 200 个不同 PR 尚未产生任何变更对；只有 P4 消费（`drainQueue`）才能腾位。**没有 P4 时这是终态**，第 201 个 PR 的首见对以 `degraded seed-pair-pending` 显名、不写库；P4 在席后 `retries` 计数继续、每轮重试直到入队。交接写明该上界。

**CI 面（硬约束 1）**：只用 `snapshot.checks` 与 `snapshot.checksRollup`，源码零 `fetchChecks`。
**硬约束 2**：`unresolvedThreads` 恒 0、`reviewDecision` 仅计数，原样透传，由 `capabilityNotes()` 显名。
**硬约束 3**：零写入口；源码零 `markReady`/`merge`/`submitReview`。

### 3.5 能力表（`providerCapabilities`，ADR P2-2）

- `contracts/gitcode-capabilities.ts`：`ProviderCapability[]` 条目照 P1 差异表 §3 的能力矩阵（其中 `fetchChecks`/`markReady`/`merge`/`submitReview` 声明不支持）。
- 行在席判定 `ctx.forge.readiness({forge:'gitcode', host:'gitcode.com', owner:'openJiuwen', name:'jiuwenswarm'}, new AbortController().signal)`（`ForgeRepository` 四字段，上游 `readiness(repository, signal)` 同形）；订阅 `ctx.on('forge/providers-changed')` 刷新。
- 判定抛错或非 `ready` → 空表＋`capabilityNotes()`＝「能力表不可用（fail-closed）」。`writeCapabilities` 恒 `'unsupported'`（P1 声明）。
- 三个成员是 `WorkbenchService` 只读属性，不进 `PrSnapshot`/`SourceHealth`。

### 3.6 GithubProvider（`github.ts`，D4）

| forge 字段 | 来源 | 规则（穷举，无未定义分支） |
|---|---|---|
| `state` | PR `state`＋`merged_at` | `merged_at` 非 null → `merged`；`open` → `open`；否则 `closed` |
| `draft` | `draft` | 原样 |
| `mergeability` | `mergeable`＋`mergeable_state` | `false` 或 `dirty` → `conflicting`；`true` 且 `clean` → `mergeable`；**其余全部**（`unstable`/`blocked`/`behind`/`draft`/`unknown`/`null`/缺字段）→ `unknown` |
| `checksRollup` | `status(state,statuses,*)`＋`check-runs(check_runs,*)` | 两侧**条目数均为 0** → `none`；否则按固定优先级：任一条目落在 `{failure, cancelled, timed_out, action_required, stale, startup_failure}` 或 status 行 `state∈{failure,error}` → `failure`；否则任一条目落在 `{pending, in_progress, queued, requested, waiting, null 未完成}` 或 status 行 `pending` → `pending`；否则全为 `success`/`skipped`/`neutral` → `success`；**其余任何取值（`zap`、空串、`null`、未知 conclusion）→ `failure` 并在该 PR health 记 `degraded unknown-conclusion:<v>`（fail-closed）** |
| `checks` | 同上 | 合成 1 条 `github checks (N)` |
| `reviewDecision` | `pulls/{n}/reviews`（每用户最新） | 任一最新态 `CHANGES_REQUESTED` → `changes-requested`；否则有 `APPROVED` → `approved`；否则有 review 面但无结论 → `review-required`；**请求失败不静默**：保留上一次已知值，并在该 PR health 记 `degraded`（message 带失败码） |
| `unresolvedThreads` | — | 恒 0（`capabilityNotes()` 显名） |
| 其余 | PR 对象 | `additions`/`deletions`/`headSha`/`updatedAt`/`title`/`author`/分支名 |

- **PR 上限唯一值＝10**（每 PR 每轮 4 次请求、60 轮/时 ⇒ 240 次/时/PR；10 PR 合计 2400 次/时，认证配额 5000/时）；第 11 个起记 `degraded`「GitHub quota limit, not watching」。
- 并发 ≤4（上限仍 4）；退避 60→120→…→600s；失败码穷举：401/403（GitHub 配额或权限）→`unauthenticated`（message 带 `X-RateLimit-Remaining` 或主机原文）、404→`not-found`、429/5xx→`unavailable`、响应超过 `maxOutputBytes`→`too-large`、非 JSON→`unavailable`（message `not JSON`）、网络超时/中止→`unavailable`（message 带 `timeout`）。所有分支都落到 §3.7 的 PR 级 health。

### 3.7 Health（复用 `SourceHealth`）

| sourceId | 口径 |
|---|---|
| `community:<platform>:pr:<o>/<r>/<n>` | `ok`→`up`；`not-found`/`unauthenticated`→`down`；`unavailable`/`too-large`/`queue-full`/`unknown-conclusion`/`seed-pair-pending`→`degraded` |
| `community:<platform>` | `down` 仅当连续 3 轮 ≥50% 被 watch 的 PR 失败 |
| `community:seed:<platform>` | §3.2 |

## 4. 显名偏离（需 owner 裁定的完整清单）

| # | 偏离 | 替代验收 |
|---|---|---|
| D1 | GitHub 只扫配置仓的**第一页**（≤50 条），不做全站作者枚举；`Link rel=last>1` 记 `degraded`，而门①要求 seed `degraded` 为 0 ⇒ 若仓内 open PR 超一页，门①会失败并显名（本批两条仓实测均未超页，13:13） | 集合全等（§5.1） |
| D2 | 新 kind `pr-seeded`（ADR P2-1） | 21 键断言 |
| D3 | 每日刷新＝本服务 24h 定时器 | 防重入＋清理单测；P4 删本定时器 |
| D4 | 新增 `GithubProvider`（不注册 `ctx.forge`；dev profile 无 GitHub 包） | 真机 GitHub 快照由它产出 |
| D5 | GitCode 身份：`username` 必填，令牌只校验 | 三态单测 |
| D6 | Issue 播种/轮询移 P3 | P3 提示词 |
| D7 | P4 队列落 `workbench_cursors` | §3.4 单测 |
| D8 | 无令牌 GitCode 播种跳过、不整仓 watch | §5.2 |
| D9 | 首见 kind 归属 P4（P2 只出 `before:null`） | ADR P2-1 |
| D10 | 工作区沿用 `/mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard`（P0/P1 既定位），不迁 `~/dev/<repo>` | 不迁，迁移由 owner 另立 |
| D11 | P0 冒烟入口（shell 形式）不在本批迁移 | 挂账 |
| D12 | 本批无建 PR 动作（无远端） | 挂账 P1 F-05 |
| D13 | 母纲 §5 全局门 2（`application: applied`）未达成 | §9.1 |
| D14 | 首见对在「可腾位」格挤掉最旧的变更对（P4 可能漏一条变更事件） | §3.4 丢弃表 vetted；P4 契约接受 `dropped>0` |
| D15 | 无 P4 时第 201 个首见对不写库、以 `degraded seed-pair-pending` 显名 | §3.4 上界段；P4 接入后自动重试 |
| D16 | GitHub 同时 watch 的 PR 上限 10（配额） | §3.6；超出记 `degraded` |
| D17 | GitCode 每仓最多扫 3 页（150 条），超出记 `degraded` 且 G1 判失败 | §3.2 |

## 4.5 机器源逐值转录（每条断言绑定机器源）

```bash
cd /mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard
corepack pnpm test -- --coverage 2>&1 | tee -a ../docs/handoff/p2-g3.log
node scripts/test-count.mjs                 # 产物: 同上 TOTAL 行
node scripts/p2-oracle.mjs --platform both --out ../docs/handoff/p2-oracle-github.json --out-gitcode ../docs/handoff/p2-oracle-gitcode.json
node scripts/smoke-p2.mjs --oracle-github ../docs/handoff/p2-oracle-github.json --oracle-gitcode ../docs/handoff/p2-oracle-gitcode.json
```

| 断言原文 | artifact 路径 | 逐字复现命令 | 原始输出摘录 | 对账判定 |
|---|---|---|---|---|
| 基线单测 153 例全绿 | `../docs/handoff/p2-g3.log` | `corepack pnpm test` | 2026-11-08T14:19:43 `Tests  153 passed (153)` | 逐字相符 |
| 每文件例数＋TOTAL | 同上（`TOTAL` 行） | `node scripts/test-count.mjs` | `TOTAL<TAB><数字>` | 机器行逐字 |
| 播种集合（GitCode） | `../docs/handoff/p2-oracle-gitcode.json` | `node scripts/p2-oracle.mjs --platform gitcode --out-gitcode ../docs/handoff/p2-oracle-gitcode.json` | `{"gitcode":[…],"at":"…"}` | 与 run log `seed gitcode=` 排序后全等 |
| 播种集合（GitHub） | `../docs/handoff/p2-oracle-github.json` | `node scripts/p2-oracle.mjs --platform github --out ../docs/handoff/p2-oracle-github.json` | `{"github":[…],"at":"…"}` | 与 run log `seed github=` 全等 |
| `/user` 无凭据 403 | `fixtures/gitcode/user-anon-403.json`（P1 已有） | `node scripts/p2-oracle.mjs --mode mitm-none` | 2026-11-08T13:29:14 `403`＋`no scopes:read_user` | 只记录主机形态；门②不依赖它 |
| per_page 不封顶 | 本文 §2.2 | `node scripts/p2-oracle.mjs --mode probe-perpage` | 13:32:42：请求 `per_page=N` 实得 `rows=N`（N∈{3,20,50,100}） | `rows===per_page` |
| GitHub 空 status（历史样本，非逐字复现） | `fixtures/github/status-uni-core-75.json`（由 2026-11-08T13:33:25 的 `gh api` 抓取，抓取脚本 ingest 后即入库、不再依赖 live API） | `node scripts/fixtures-capture.mjs --repo dptech-corp/Uni-Core --pr 75`（文件内 `_sha` 固定为 `aeabab13…`；live status 会变，此表只作形态样本，门判定用 §7 回放用例） | 13:33:25 `state=pending total_count=0` | 条目数 0 → `none` |
| 契约 21 键 | `test/contracts.test.ts` | `npm test -- test/contracts.test.ts` | `toHaveLength(21)` 绿 | 与 `CHANGE_LEVELS` 键数相等 |
| validator 复跑 | `../docs/handoff/P2-实施总结与质量报告.md`「plan_gate 复跑」节 | `python3.14 …/plan_gate.py --plan agent-cron-dashboard/.omo/plans/p2-pr-seeding.md --repo agent-cron-dashboard` | 见报告侧 | 逐条列名 |

## 4.6 测试计划

### 4.6.1 单测（正常＋错误＋兼容）

- 正常路径：§7 四个文件 success 分支。
- **错误路径**：HTTP 403/401/404、非 JSON、不可解析仓 URL、队列写失败、listener 抛错被吞、能力判定抛错、第 11 个 PR 拒绝。
- **兼容性**：每笔 `corepack pnpm test` 全量；既有 153 例不减、不新增 `skip`；`test/contracts.test.ts` 20→21 为有意更新，旧断言原文进附录。

### 4.6.2 E2E 用例（端到端）

每个用例按四要素写成独立小节：**前置条件 / 执行 prompt / 预期结果 / 失败判定**。

| 类别 | 用例 |
|---|---|
| 正常流程（happy path） | E2E-1 双平台播种＋快照 |
| 回归（原有功能不被破坏） | E2E-4 回归（基线 4411250 与改动后对比） |
| 边界/异常场景（error scenario） | E2E-2 无令牌降级、E2E-3 首见与变更（离线回放） |


**E2E-1 双平台播种＋快照（正常流程）**
- **前置条件**：§5.1 的前置（gh 已登录、`GITCODE_TOKEN` 注入、仓根仅 3 个未跟踪 fixtures、不使用 `--no-token`）。
- **执行 prompt**：§5.0 模板的两行（G1 模板命令 + G1 判定器），逐字复制。
- **预期结果**：§5.1 六条断言全部成立（含「无令牌泄漏」）。
- **失败判定**：任一条不成立。

**E2E-2 无令牌降级（异常场景）**
- 前置条件：真实环境无 `GITCODE_TOKEN`；`--no-token` 按 §5.4 的唯一机制运行（`P2_CANARY` → `env.GITCODE_TOKEN`，离线替身 `/user` 固定 403 `invalid token`）；「令牌缺失」形态只由单测覆盖。
- 执行 prompt：
  ```bash
  bash -o pipefail -c 'env -u GITCODE_TOKEN P2_CANARY=XAI_P2_CANARY node scripts/smoke-p2.mjs --no-token --config fixtures/p2-smoke-config.yaml 2>&1 | tee ../docs/handoff/p2-g2.log; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-gate-check.mjs --gate G2 --log ../docs/handoff/p2-g2.log
  ```
- **预期结果**：§5.2 的六条 `grep -cF` 断言全部成立。
- **失败判定**：任一 `grep -cF` 断言不成立，或出现 GitCode 播种条目。

**E2E-3 首见与变更（离线回放，边界/异常）**
- **前置条件**：无需网络；fixtures 在席。
- prompt：`npm test -- test/community-pr-watch.test.ts`
- **预期结果**：首见写快照＋`before:null` 入队；二次回放出 before/after 对。
- **失败判定**：首见重复、溢出时把首见对挤掉（策略＝满时永不挤掉首见对）、快照写失败后重复入队。

**E2E-4 回归（原有功能不被破坏）**
- **前置条件**：worktree 干净，基线 HEAD `4411250` 可检出。
- **执行 prompt**：
  ```bash
  cd /mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard && git worktree add /tmp/p2-base 4411250 && (cd /tmp/p2-base && corepack pnpm install --frozen-lockfile && corepack pnpm test) ; git worktree remove /tmp/p2-base --force ; corepack pnpm test && corepack pnpm run typecheck
  ```
- **预期结果**：基线 153 全绿；改动后全绿且例数 ≥153＋新增。
- **失败判定**：任一门 rc≠0、例数下降、出现 `skip`。

## 4.7 回滚方案

| 破坏性步骤 | 备份 | 回滚命令 |
|---|---|---|
| 笔 1 改 `contracts/events.ts` | 原 blob 由 git 保留 | `git revert <笔1>`；`git checkout <笔1>^ -- contracts/events.ts contracts/gitcode-capabilities.ts` |
| 笔 2–5 新增 `src/community/*` 与 `index.ts` 接线 | 新增文件删除即回退 | `git revert <笔N>`；`git checkout <笔N>^ -- packages/agent-cron-dashboard/src/index.ts` |
| 笔 6 冒烟（只读远端） | 只写 `workbench_cursors` | `git revert <笔6>`；游标**键级删除**（表 API `delete(<key>)`），禁通配删除 |
| 笔 1 的 `toHaveLength` 20→21 | 旧断言进附录 | `git checkout <笔1>^ -- test/contracts.test.ts` |

## 4.8 CI 影响面

1. **测试清单**：新增 `test/` 目录下的四个测试文件（`test/community-identity.test.ts`、`test/community-seeding.test.ts`、`test/community-pr-watch.test.ts`、`test/community-github-adapter.test.ts`），**改动**既有**测试**文件 `test/contracts.test.ts`。
2. **受影响生成物与重生成义务（重冻复核）**：`build/packages/**`（每次 run 前 `build-bundles.mjs` 重建，不提交）；`config-validate.ts`/`contracts.ts` 由 `sync-contracts.mjs` 生成；本次改的 `contracts/events.ts` 与新增 `gitcode-capabilities.ts` **不在同步清单**（不会被复制），因此重冻义务为无，并由笔 1 的 `node scripts/sync-contracts.mjs --check` rc=0 证明**既有两份拷贝未被本次改动波及**（不是「新文件已被同步」的证明）。
3. **tracked-py manifest 义务**：本批无新增 `.py`，无 manifest 变更（义务面以肯定句申报：manifest 保持现状，不需重生成）。
4. **rerun 预案**：受影响面＝被限流平台的列表读与 PR 读；429/限流时按 §3.6 退避与令牌配额重算，`smoke-p2.mjs --resume <log>` 续跑，已成功轮次不重计。
5. **RED/GREEN 判例锚**：§6 的 RED 与 GREEN 各 1 例（文件名＋断言原文＋实得值）进报告附录（ASCII 词形 `RED`/`GREEN` 逐字出现）。

## 5. 验收门与证据（同一 run 机读判定）

**机器可解析的行格式（唯一约定，供 `p2-gate-check.mjs` 解析）**

| 前缀 | 格式 | 例 |
|---|---|---|
| `seed ` | `seed <platform>=[<number>,…]`（JSON 数组，空为 `[]`） | `seed gitcode=[9704,9722]` |
| `round#` | `round#<n> platform=<p> key=<owner/repo#n>` | `round#7 platform=gitcode key=openJiuwen/jiuwenswarm#9722` |
| `snapshot=` | `snapshot=<key> state=<s> rollup=<r> at=<ISO>` | `snapshot=… state=open rollup=success at=…` |
| `health ` | `health <sourceId> state=<s> message="…"` | `health community:seed:gitcode state=up message=""` |
| `identity ` | `identity <platform> state=<s> message="…"`；**拒绝态的 message 固定以 `GitCode /user refused:` 或 `no token in GITCODE_TOKEN` 开头** | `identity gitcode state=down message="GitCode /user refused: HTTP 403 ***"` |

> 编号约定：**G1**＝真机双平台快照门；**G2**＝无令牌降级门；**G3**＝单测/覆盖率门。母纲全局门另用「母纲 §5 门 1..5」称呼（§9.1），与 G1–G3 不混。

### 5.0 门命令模板（G1/G2/G3 同一形状：`bash -o pipefail -c` + `tee` + rc 检查 + 判定器）

```bash
bash -o pipefail -c '<第1步> && <第2步> ... 2>&1 | tee <log>; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-gate-check.mjs --gate <G> --log <log> [...额外输入]
```

每个门**恰好一个 log 文件、一条判定器命令**，rc 由 `PIPESTATUS[0]` 取（`tee` 不吞退出码），并把结果**写进 log 末行**（模板命令末尾追加 `echo "EXIT rc=$rc"; test "$rc" -eq 0`）——判定器只读 log，从 `EXIT rc=` 行拿 rc，不依赖 shell 状态。

### 5.1 G1 真机双平台快照（链式，含播种）

```bash
bash -o pipefail -c 'cd /mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard && node scripts/build-bundles.mjs 2>&1 | tee ../docs/handoff/p2-g1.log && GITCODE_TOKEN="$(cat ~/.gitcode_token)" node scripts/p2-oracle.mjs --platform both --out ../docs/handoff/p2-oracle-github.json --out-gitcode ../docs/handoff/p2-oracle-gitcode.json 2>&1 | tee -a ../docs/handoff/p2-g1.log && GITCODE_TOKEN="$(cat ~/.gitcode_token)" node scripts/smoke-p2.mjs --config fixtures/p2-smoke-config.yaml --oracle-github ../docs/handoff/p2-oracle-github.json --oracle-gitcode ../docs/handoff/p2-oracle-gitcode.json --window-minutes=30 --gitcode-interval-ms=10000 --github-interval-ms=60000 2>&1 | tee -a ../docs/handoff/p2-g1.log; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-gate-check.mjs --gate G1 --log ../docs/handoff/p2-g1.log --oracle-github ../docs/handoff/p2-oracle-github.json --oracle-gitcode ../docs/handoff/p2-oracle-gitcode.json --token-file ~/.gitcode_token
```

| # | G1 断言 | 判据 |
|---|---|---|
| 1 | 两平台播种集合全等 | log 的 `seed github=`/`seed gitcode=` 与各自 oracle JSON 排序后相等 |
| 2 | 轮次 | 按 `key=` 分组，**平台各自门槛**：GitHub 每 PR ≥23（`T=70 s`）、GitCode 每 PR ≥125（`T=13 s`）；公式 `ceil(floor(1800/T)×0.9)`（§5.5） |
| 3 | 无降级 | `community:seed:*` 的 `state=degraded` 出现次数为 0 |
| 4 | 双平台快照 | 两平台各 ≥1 条 `snapshot=` 行，`rollup∈{none,pending,success,failure}` |
| 5 | 链式 rc | `EXIT rc=0` 行出现且值为 0（§5.0 模板） |
| 6 | 无令牌泄漏 | **由账本内脚本完成**：`scripts/p2-gate-check.mjs --gate G1 --log ../docs/handoff/p2-g1.log --token-file ~/.gitcode_token`（脚本自己读令牌值、在内存里做 `grep -F` 计数、**不打印令牌**）；判据＝计数为 0 |

### 5.2 G2 无令牌降级门（与 G1 是两次独立 run）

```bash
bash -o pipefail -c 'env -u GITCODE_TOKEN P2_CANARY=XAI_P2_CANARY node scripts/smoke-p2.mjs --no-token --config fixtures/p2-smoke-config.yaml 2>&1 | tee ../docs/handoff/p2-g2.log; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-gate-check.mjs --gate G2 --log ../docs/handoff/p2-g2.log
```

| # | G2 断言 | 判据 |
|---|---|---|
| 1 | 无 canary | `XAI_P2_CANARY` 出现次数＝0 |
| 2 | 脱敏路径被走到 | `grep -cF '***'` ≥1 **且** `grep -F '***' | grep -vc '^identity gitcode'` ＝ 0 |
| 3 | 真实日志路径 | 精确行 `identity gitcode state=down message="GitCode /user refused: HTTP 403 invalid token: ***"` 出现次数＝1（`***` 由替身回显令牌位 + “`redact` 按注入的 secret 值做**字面替换** `secret→***`（不限位置）”产生） |
| 4 | 播种跳过 | `seed gitcode=[]` 出现次数＝1 |
| 5 | seed 降级 | `health community:seed:gitcode state=degraded` 出现次数≥1 |
| 6 | identity 降级 | 行模式 `identity gitcode state=down …` 出现次数＝1 |

「令牌缺失」形态（变量不存在、不发请求）只由单测覆盖（§7 identity 用例）。

### 5.3 G3 单测、契约同步与覆盖率

```bash
bash -o pipefail -c 'cd /mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard && corepack pnpm test -- --coverage 2>&1 | tee ../docs/handoff/p2-g3.log && node scripts/test-count.mjs 2>&1 | tee -a ../docs/handoff/p2-g3.log && node scripts/sync-contracts.mjs --check 2>&1 | tee -a ../docs/handoff/p2-g3.log && node scripts/validate-config.mjs 2>&1 | tee -a ../docs/handoff/p2-g3.log; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-coverage-gate.mjs --lcov coverage/lcov.info 2>&1 | tee -a ../docs/handoff/p2-g3.log
node scripts/p2-mirror-check.mjs 2>&1 | tee -a ../docs/handoff/p2-g3.log
node scripts/p2-gate-check.mjs --gate G3 --log ../docs/handoff/p2-g3.log
```

| # | G3 断言 | 判据 |
|---|---|---|
| 1 | rc 链 | 模板命令 rc=0（含 `pnpm test`、`test-count`、`sync-contracts --check`、`validate-config`） |
| 2 | 用例数 | `TOTAL ≥ 201`（153 基线 + §7 最小 48）；行格式 `TOTAL<TAB><n>` |
| 3 | 零新增 skip | 当前 log 的 vitest 汇总行取 `<s>`；基线文件 `../docs/handoff/p1-test-count.txt` 由 `scripts/p2-baseline-record.mjs` 从 `p1-test-log.txt` 生成，**唯一格式**＝首行 `skip=<s>`、第二行 `passed=<n>`、第三行 `commit=4411250`、第四行 `log_sha256=<sha>`；判据：当前 `<s>` ＝ 基线 `<s>` |
| 4 | 覆盖率 | `p2-coverage-gate.mjs` 输出 `COVERAGE-GATE PASS`（数据源 `coverage/lcov.info`；`src/community/**` 未覆盖行数为 0，§5.10） |
| 5 | 镜像一致性 | `node scripts/p2-mirror-check.mjs`（正典与 `P2-实施计划.md` 正文 sha256 相同）输出 `MIRROR PASS` |

### 5.5 轮次门槛推导（`Th/Tg` 定义）

**同一公式、平台各自的实测周期**：`T_gitcode=13 s`（10 s 配置 + ≤3 s 读取，§2.2 15:06 实测 12.27–12.5 s）→ `floor(1800/13)=138`，`ceil(138×0.9)=125`；`T_github=70 s`（60 s 周期 + ≤10 s 读取，§2.2 15:15 实测 8.4–8.7 s）→ `floor(1800/70)=25`，`ceil(25×0.9)=23`。计数单位＝每 key；取整规则只有一条 `ceil(floor(1800/T)×0.9)`。`round#` 实测间隔只写 `ALERT slow-round` 告警，不改门结论。

### 5.4 `smoke-p2.mjs` 旗标（全部在笔 6 实现）

| 旗标 | 语义 |
|---|---|
| `--config <yaml>` | 本次运行配置（默认 `fixtures/p2-smoke-config.yaml`）；启动时把内容打进 log |
| `--window-minutes=N` | watch 窗口（默认 30） |
| `--gitcode-interval-ms=N` | GitCode 刷新间隔（默认 10000）——脚本以 `ForgeService` 的 `Config{activeIntervalMs:N, idleIntervalMs:N}` 组合构造 `ctx.forge`（§2.2 15:06 实测：组合 8 ms，33 s 出 3 轮，间隔 ≈12.3–12.5 s），因此对 `ctx.forge.watch` 生效；门槛见 §5.1 |
| `--github-interval-ms=N` | GitHub 适配器轮询间隔（默认 60000；门槛见 §5.1） |
| `--oracle-github <json>` / `--oracle-gitcode <json>` | 两平台各一 oracle JSON，各自与播种结果比对全等 |
| `--no-token` | **唯一机制**：脚本从环境读 `P2_CANARY` 的值 → 写进被测进程 `env.GITCODE_TOKEN`（令牌被拒形态）→ 并把 GitCode `transport` 换成离线替身（`/user` 固定 403、body `{"error_message":"invalid token: <收到的 private-token 头原值>"}`——**替身回显令牌位**，因此经 `redact` 后必然出现 `***`；`pulls` 返回 `[]`）；GitHub 侧仍真跑 `gh api` |
| `--resume <log>` | 续跑同一窗口，`round#` 接着计 |

（页数规则与 §3.2／§5.1 一字不差：GitHub 只取第 1 页并按 `Link rel=last` 判超页；GitCode 取 1..3 页、短页止。）

## 5.10 覆盖率门规则（无豁免清单，二值且不可自证）

**规则**：G3 #4 的判据＝`coverage/lcov.info` 中 `src/community/**` 的 `DA:` 行里 `count==0` 的条目数 **必须为 0**；**计划内不设任何豁免清单**（先前版本的「豁免表 + 实施者填行区间」会自证，已废止）。若某行在单测内确实不可达，实施者在**该笔提交**的 commit body 里写 `[unreachable: <file>:<line> 理由]`，由 owner 在评审该笔时确认；该确认**不改变门结论**（门仍要求 0），只作为已知欠账记录进报告附录。

## 5.11 测试设计

- **用例分层**：单元（identity/seeding/github-adapter 的纯函数与回放）；集成（pr-watch 对内存 storage-domain 的真实读写，含队列落库）；E2E（§4.6.2 四个用例）。
- **Mock 设计与数据准备**：`gh` runner 可注入（fake runner 返回固定的 `gh api` 导出 JSON）；HTTP 用 `transport` 注入（fixtures 回放）；`ctx.forge` 用真实 `ForgeService`（§2.2 已实测可组）或注入 `WatchSource` fake；存储用 `dsh-storage-json` 临时目录（沿用 `row-apply.test` 的 compose 方式）。
- **每个 fix 的测试策略**：见 §7 四文件覆盖表；变异自检见 §6。

## 5.9 用例去重与覆盖率基线（TRF 部分对齐）

- **不删除用例**：`test/contracts.test.ts` 只改期望值（20→21，机器断言见 §4.5），**旧断言原文与本仓 blob（`git rev-parse 4411250:test/contracts.test.ts`）保留副本**，报告附录列出 blob SHA，满足「保留副本声明」。
- **覆盖率基线**：本批不设覆盖率基线文件（覆盖率判据只有 §5.10 的「未覆盖行＝0」），也不引入棘轮，禁 `--write-baseline`。

## 6. TDD 段

覆盖率要求：新增代码（`src/community/**`）覆盖率目标是 100%，以 `corepack pnpm test -- --coverage` 的 text summary 为机器源，通过条件见 §5.3。

1. **RED**：先写断言，`corepack pnpm exec vitest run test/<file>.test.ts` 失败，失败输出摘录进报告附录（含断言原文与实得值）。
2. **GREEN**：最小实现，`corepack pnpm test` 全绿，记录哪几个文件被改。
3. **REFACTOR**：测试保护下重构（例如把 HTTP 分页循环抽成 `seeding.ts` 内部私有函数复用；**oracle 脚本不得引用** `seeding.ts` 的任何函数），复跑全绿。
4. **变异自检**：每文件取反 1 个关键判定（`merged_at` 空串、`total_count===0`→`none`、首见对不丢），必须变红，恢复后复绿。
5. **G3 覆盖率（二值，规则见 §5.10）**：`corepack pnpm test -- --coverage` 生成 `coverage/lcov.info`；随后跑 `node scripts/p2-coverage-gate.mjs`，通过＝输出 `COVERAGE-GATE PASS`。判据：`src/community/**` 的 `DA:<line>,<count>` 中 `count==0` 的条目数**必须为 0**；**没有豁免清单表**（上面 §5.10 已写明不存在豁免集合）。

## 7. 测试矩阵（≥48 例）

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test/community-identity.test.ts` | ≥10 | gh 发现/覆盖/失败；GitCode 三态（无令牌不发请求、401、他人 degraded）；`redact` 定点（`***`）；源码扫描不读替身文件 |
| `test/community-seeding.test.ts` | ≥12 | `listOpenAuthored` 与 oracle 在同 fixtures 上**集合相等**（不是函数体一致）；GitHub 回放（作者过滤、fork sourceId、Link 截断）；GitCode 回放（短页、3 页满、`merged_at:""`）；无令牌零条目；去重；24h 防重入；与 §2.2 读数一致性 |
| `test/community-pr-watch.test.ts` | ≥14 | 首见幂等（只以快照表判定；入队失败的重试独立于 diff）；先入队后写快照；写失败重试；七字段 diff；队列满三种（首见挤掉最旧变更对并入队／变更对丢最旧或丢弃本条／全首见满则首见对仅重试并 `queue-full`）；`drainQueue`；零写调用/零 `fetchChecks`；能力表 fail-closed |
| `test/community-github-adapter.test.ts` | ≥12 | 映射穷举（conflicting/mergeable/unknown 全分支）；`none` 判据（条目数**零值**）；**未知 conclusion 用例（`zap`/空串/null → failure＋degraded）**；`failure` 集合含 `action_required`/`stale`/`startup_failure`/`error`；`pending` 集合；reviews 四态；**边界值：恰好 10 个 PR 放行、第 11 个拒绝**（唯一上限 10）；并发**恰好 4 放行、第 5 个排队等待**（上限即 4）；失败码含 403/too-large/非 JSON/超时 |

## 8. 文件面与提交（粒度、小步快跑、门禁）

**笔 0（基线；只新增一个脚本、不改产品源码）**：先在 `4411250` 的干净树上写 `scripts/p2-baseline-record.mjs` 并单独 commit，再执行

```bash
bash -o pipefail -c 'cd /mnt/data2t/migrated/dev/dsh-dev/agent-cron-dashboard && corepack pnpm test 2>&1 | tee ../docs/handoff/p1-test-log.txt; rc=${PIPESTATUS[0]}; echo "EXIT rc=$rc"; test "$rc" -eq 0'
node scripts/p2-baseline-record.mjs --log ../docs/handoff/p1-test-log.txt --out ../docs/handoff/p1-test-count.txt
sha256sum ../docs/handoff/p1-test-log.txt ../docs/handoff/p1-test-count.txt
```

并把 `commit=4411250`、log 的 sha256 写进报告；该文件**不提交**（在 `.gitignore` 外，属证据），G3 #3 读它。

**工作分支：`main`**（本仓 P0/P1 均在 `main`、无远端、不新建分支）。**小步快跑，做完一批提交一批**：每笔完成后即跑 `corepack pnpm test`＋`corepack pnpm run typecheck`；**每个任务独立 commit**，不与其他笔合并 commit，禁止攒到末尾统一提交。提交信息**统一只用 conventional 的 `feat(p2):` 前缀**（含测试、文档、修复笔在内一律 `feat(p2): <scope>: <what>`），body 写「改什么/为什么/如何验证」。

每笔提交前执行（唯一写法）：`python3.14 ~/.factory/hindsight-droid/gates/commit_gate.py --staged --message "<msg>" --repo <repo>`，rc≠0 不提交。

| 笔 | 交付 | 回滚 |
|---|---|---|
| 0 | `scripts/p2-baseline-record.mjs`（**独立 commit `feat(p2): baseline recorder`**）＋基线证据（`p1-test-log.txt`、`p1-test-count.txt`，不提交）；不改产品源码 | `git revert <笔0>`（回滚脚本）；证据文件直接删除（在 `../docs/handoff/`，不在版本控制内） |
| 1 | `scripts/fixtures-capture.mjs`＋5 件 fixtures（`fixtures/github/{pull-75,pulls-head,status-uni-core-75}.json`、`fixtures/gitcode/{pull-9722,pulls-mine-all-p1}.json`）＋`contracts/events.ts`（`SnapshotPair`+`pr-seeded`）、`contracts/gitcode-capabilities.ts`、两个 ADR、`test/contracts.test.ts`（20→21，旧断言原文进报告） | `git revert <笔1>` |
| 2 | `identity.ts`＋其单测 | `git revert <笔2>` |
| 3 | `github.ts`＋其单测＋`scripts/probe-forge-context.mjs` | `git revert <笔3>` |
| 4 | `seeding.ts`＋其单测 | `git revert <笔4>` |
| 5 | `pr-watch.ts`＋`src/index.ts` 接线＋其单测 | `git revert <笔5>` |
| 6 | `scripts/p2-oracle.mjs`＋`fixtures/p2-smoke-config.yaml`＋`scripts/smoke-p2.mjs`＋`scripts/p2-gate-check.mjs`＋`scripts/p2-coverage-gate.mjs`＋`scripts/p2-mirror-check.mjs`＋`../docs/handoff/P2-实施计划.md`（镜像首版）＋真机 run 产物 | `git revert <笔6>`；游标**键级删除**（表 API `delete(<key>)`，禁通配删除用户存储） |
| 7 | 报告＋`../docs/handoff/P2.md`＋P3 提示词＋镜像最终同步（`p2-mirror-check.mjs` 复跑 PASS） | `git revert <笔7>` |

**推送与建 PR**：本仓**无 origin**，`push_gate` 无法执行 → **推送门阻断待决**（不豁免、不宣称通过），由 owner 决定建远端或签收推迟；本批无 `gitcode_create_pr` 动作（D12）。

## 9. 全局门与 validator

### 9.1 母纲 §5 全局门（批次结束回填）

| 门 | 状态 |
|---|---|
| 1 单测全绿、无新增 skip | 未跑（笔 7 回填） |
| 2 `install_bundle`→`application: applied`＋inspect 在席 | **未达成**（D13，P1 F-05 同条） |
| 3 冒烟 rc=0 输出留证 | 未跑 |
| 4 交接落盘＋git log 可见 | 未跑 |
| 5 实跑落证 | §2.2 已 12 条；冒烟未跑 |

### 9.2 validator 机器证据（对**落盘文件本人**复跑）

运行命令（唯一表述）：`python3.14 ~/.factory/hindsight-droid/gates/plan_gate.py --plan agent-cron-dashboard/.omo/plans/p2-pr-seeding.md --repo agent-cron-dashboard`。**本轮的时间／rc／SHA256 只记在 `../docs/handoff/P2-实施总结与质量报告.md` 的「plan_gate 复跑」节**，正文不写。
- 修复前的失败规则（v6 rc=2 记 20 条、v5 记 25 条）分三类落点：**已对齐**（TYPE／TDD 四段／提交粒度／小批／shell／E2E 五要素／MS_STRUCT／CI 影响面／回滚／数字一致性，对应 §4.5 以下的机制节）、**部分对齐**（TRF 棘轮声明已点名记录文件，无 AST 同源自动化；TRF 棘轮声明已点名基线并禁 `--write-baseline`，无 AST 同源自动化）、**未对齐待 owner**（仅「新增代码覆盖率 100%」）。

## 10. 预算

读入 35k（已用约 34k）｜编码＋测试 75k｜真机冒烟/修错 60k｜余量 60k。

## 11. 风险

1. 30 分钟窗内 CI 可能 0 次翻转 → 观察项显名（§5.1）。
2. GitHub 单仓第一页上限（≤50）与 10 个 PR 上限（§3.6）。
3. GitCode 3 页上限 → `degraded`。
4. 他人合入/关闭我方 PR → 集合全等失败一次，重跑即可；**窗口内我方 PR 被合并/关闭 → 该 PR 的 `round#` 计数不足门槛，G1 判失败并显名（属环境事件，不计计划缺陷，重跑即可）**。
5. 轮次门槛按平台各自实测周期（GitHub 每 PR ≥23、GitCode 每 PR ≥125，§5.1／§5.5 同一公式），低于门槛即失败并显名。

## 12. 各轮 P1 映射（R1–R10 共 60+ 条，逐条一处定稿）

| 轮 | 条 | 定稿位置 |
|---|---|---|
| R1-1..8 | 证据／偏离／seeded／state 口径／capabilityNotes／越界／fail-open／无 token | §5.1 §4 §3.4 §3.5 §3.1 |
| R2-1..17 | 链式门／全局门／队列落库／映射／head=/订阅/脚本/提交/规则0/TDD/探针/无令牌/存活/备选包 | §5.1 §9.1 §3.4 §3.6 §3.2 §3.3 §8 §6 §2.2 §5.2 §2.2 D4 |
| R3-1..15 | 能力旁路／D4 理由／head=／门 oracle／整仓 watch／宪法／契约／per_page／status／PR 级／存活／证据／403／笔误／备选 | §3.5 §4D4 §3.2 §5.1 §4D8 §8 §3.4 §2.2 §3.6 §3.7 §2.2 §9.1 §2.2 §1 §4D4 |
| R5 / R6 / R7 / R8 / R9 / R10 | 正文缺失／canary／优先级／对账／日期／oracle 同源／首见顺序／命令／幂等／WatchSource／上限／穷举 | §0 §5.2 §3.6 §9.2 §2.2 §3.2 §3.4 §8 §3.4 §3.3 §3.6 §3.6 |
