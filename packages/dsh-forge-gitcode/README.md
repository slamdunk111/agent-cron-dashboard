# dsh-forge-gitcode

GitCode（`https://gitcode.com/api/v5`，GitHub v3 兼容形态）的 `dsh-experimental-forge` provider。装好后在 profile 中出现行 `forge-gitcode`。

- 凭据：环境变量名（默认 `GITCODE_TOKEN`），不落配置文件；无 token 时降级公共只读面。
- P0 为骨架（行注册 + 配置校验）；P1 完成端点差异探测后实现 `fetch`/`findByHead`/`checks`/`merge` 等能力并按实测结果声明不支持项。
