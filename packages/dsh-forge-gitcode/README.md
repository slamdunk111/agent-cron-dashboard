# dsh-forge-gitcode

GitCode（`https://gitcode.com/api/v5`）的 `dsh-experimental-forge` provider。装好后在 profile 中出现两行：`forge`（注册表）与 `forge-gitcode`（本包）。

## 用法

```yaml
- id: forge
  name: '@deepseek-ai/dsh-experimental-forge'
- id: forge-gitcode
  name: dsh-forge-gitcode
  config:
    tokenEnv: GITCODE_TOKEN   # 环境变量名，不落配置文件
```

无 token 时降级为公共只读面（`pulls` 族端点可匿名读），`readiness` 报 `unauthenticated`。

## 能力（按 api/v5 实测声明，详见 `../../docs/gitcode-v5-diff.md`）

| 能力 | 状态 | 说明 |
|---|---|---|
| `repositoryFromRemote` / `changeRequestFromUrl` / `changeRequestUrl` | 支持 | 远端 `https/git@/ssh://` 三形；页面 `/pull/{n}`、`/pulls/{n}`、`/merge_requests/{n}` 三形 |
| `fetch` | 支持 | 详情端点；增删行由 `files` 汇总（PR 体不带） |
| `findByHead` | 支持 | `?state=open&head=<branch>` |
| `readiness` | 支持 | `GET /api/v5/user`；匿名 403 `no scopes:read_user` 视为未认证 |
| `diff` | 支持 | 网页 `/pull/{n}.diff`（API `.diff` 返回 400） |
| `fileText` / `fileUrl` | 支持 | `contents?ref=<commit>` → `download_url`（`raw.gitcode.com`） |
| `fetchChecks` | 声明不支持 | 无 check-runs/检查清单端点（404×5）；只有 `mergeable_state.ci_state_passed` 布尔 |
| `markReady` / `merge` / `submitReview` | 声明不支持（待 token 探测） | 写端点形态未闭合，见差异表 §4 |

## 已知限制

- CI 只能给一条合成检查项 `ci (N tasks)`，无逐检查状态与链接。
- `unresolvedThreads` 恒为 0（无逐线程解析态端点）。
- `reviewDecision` 只由审批计数推导（`approvers >= required` → `approved`，否则 `review-required`）；**GitCode 没有 reviews 端点（`/pulls/{n}/reviews` 404），因此 `changes-requested` 无法判定，本 provider 从不产出该值**。
- 时间戳缺失时 GitCode 发 `""` 而非 `null`，映射按非空字符串判定。
