# ADR P3-1：Issue 轮询的契约增量与探测结论落点

- 状态：已采纳（P3 实施批，2026-11-08）
- 关联：`contracts/adr/P2-pr-seeded-event.md`（首见对模式）、`contracts/adr/P2-gitcode-capabilities.md`（能力常量先例）
- 受影响 plan：P3（本批）、P4（事件分级与快照对消费）、P7（UI 读数）、P8（发布说明）

## 1. 动机

母纲 §6 规定「任何 plan 改契约 → 本 plan 内写 ADR」。P3 原计划不改 `contracts/events.ts`/`records.ts`/`config.schema.json`，实际实施中必须落地两处增量，否则会让 P4 无法区分首见对、让运行时拿不到 GitCode 令牌：

1. **首见 issue 的 kind**：P2 用 `pr-seeded` 标记「PR 首见对（`before: null`）」。issue 没有对应键，若 P3 只写 `SnapshotPair{before: null}` 而无独立 kind，P4 的分级表只能把 issue 首见当作无类型对。按 P2-1 的模式（P3 只产快照对，kind 由 P4 造），本批**只增一个键 `issue-seeded`**（`medium`，首见不通知），不新增事件结构。
2. **GitCode 令牌的来源**：`identities[].tokenEnv` 只是变量名，运行时需要值。P2 的冒烟脚本从 `process.env` 读，行内服务同样只读环境；P3 复盘实测发现 GitCode 侧存在一个**只能用令牌访问的读取面**（`GET /api/v5/user/issues`，匿名 400），令牌缺失即不可用，所以令牌读取规则要与身份解析共用同一条（`tokenOf(env, tokenEnv)`），并且**行作用域**——不带 `--with-issues` 启动时行不建 issue 轮询、不读令牌（P2 R 轮「host-scoped credentials」同款要求）。
3. **探测结论落点**：母纲 P3 输入锚点写「`docs/gitcode-v5-diff.md`（若已产）」。P1 已产该表但**不含 issue 端点**（P1 表 §1 只有 pulls 面），P3 实测结论放两处——差异表追加 §7（端点矩阵与字段映射），完整证据链落 `../docs/probes/p3-gitcode-issues.md`（含请求头矩阵、时序读数、fixtures 对照）。

## 2. 变更面（只增不改）

| 文件 | 变更 | 兼容性 |
|---|---|---|
| `contracts/events.ts` | `CommunityChangeKind` 增 `'issue-seeded'`；`CHANGE_LEVELS` 增同名键（值 `medium`） | 20→21→22 键；两个既有消费方（`index.ts` 的 zod 枚举、`test/contracts.test.ts` 的计数断言）跟着更新；P4 分级表必须含该键且**不派发** |
| `contracts/gitcode-capabilities.ts` | `GITCODE_CAPABILITIES` 增 `gitcodeIssueListMine`（已实现）、`gitcodeIssueSearch`（已实现但**计划不用**），`GITCODE_UNSUPPORTED` 不变 | 常量数组加项，既有项与顺序不动 |
| `config.schema.json` / `records.ts` | **不改** | `IssueSnapshot` 与 `watch.issuePollIntervalMs` 在 P0 已冻结，P3 直接消费 |

不新增存储域：issue 快照写既有 `workbench_snapshot_issue`，快照对与游标写既有 `workbench_cursors`（键 `<platform>/<owner>/<repo>/<number>:issuequeue`）。

## 3. 首见对与 P4 的接缝（延续 P2-1）

- P3 只写快照与 `SnapshotPair<IssueSnapshot>{before: null, after, at}`，**不造事件**。
- P4 读到 `before === null` 的对时造 `issue-seeded`（`medium`），并按 P2-1 的规则不派发通知。
- 一条 issue 的快照对队列与 PR 队列**同形不同键**（`:issuequeue` 后缀），避免两服务共写同一游标记录。

## 4. GitCode issue 端点结论（摘要，全文见 §1 落点）

| 端点 | 实测（2026-11-08T18:16Z..18:25Z） | 结论 |
|---|---|---|
| `GET /repos/{o}/{r}/issues?state=…&per_page&page` | 200/匿名 200；`number` 为**字符串**；含 `user`/`labels`/`assignees`/`comments`/`updated_at` | 可用（仓内枚举） |
| `GET /repos/{o}/{r}/issues/{n}` | 200/匿名 200 | 可用 |
| `GET /repos/{o}/{r}/issues/{n}/comments?per_page=1&page=1` | 200，**倒序**（最新在前），`page=2` 即次新 | 可用（最后评论者来源） |
| `GET /search/issues?q=author:<me>` | 200，**29 行**（18:44Z 复测；首测 22 行，见 probe 文档 §2）；行内**无 `user`**；`per_page>50` 拉全页时 400 | 可用但不采用（覆盖不全，见 probe 文档 §2） |
| `GET /search/issues?q=repo:<o>/<r>` | 200，`openJiuwen/jiuwenswarm` 48 行 | **用作种子仓发现**：`watch.repos[]` 每仓一页（配 `repo:` 查询） |
| `GET /user/issues?filter=created&state=…` | 200，需 `private-token`（匿名 400） | 采用：GitCode 主路径（令牌必需） |

无令牌时：GitCode 身份 `down`（`identity.ts` 既有三态），issue 轮询**显名降级**为 `health community:issue:gitcode state=down message="…"` 并写一条 `issue:gitcode` 游标记录说明原因，不静默跳过。

## 5. 已知缺口（显名，不冒充）

- GitCode `search/issues?q=author:<me>` 与 `/user/issues?filter=created` 的覆盖面**不相交**（18:44Z：29 vs 61，交集 0；两读对该用户用了不同的可见性/归属口径，响应体给不出原因），因此 P3 **只**以 `/user/issues` 为「我提交的」种子面；`watch.repos[]` 里的 GitCode 仓另用 `search/issues?q=repo:<o>/<r>` 做一页覆盖（48 行），两者合并去重。
- GitCode 响应头无 `ETag` / `X-RateLimit-*` / `Retry-After`（18:24Z 实测 `date` 等内部头之外为空），GitCode 侧退避为固定指数（复用 P2 的 `activeIntervalMs × 2^n` 上限 600 s 形态）。
- GitHub `search/issues` **不带 ETag**（三次连发 18:17Z、18:18Z 均无 `etag` 头，`cache-control: no-cache`）：ETag 只在逐条详情端点成立（`GET /repos/{o}/{r}/issues/{n}` 304 实测 10:16:55Z），所以「ETag 304 路径」落在详情拉取，不落在列表。
