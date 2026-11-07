# agent-cron-dashboard

dsh 工作台主 bundle：社区 PR/Issue 监控 + 定时任务巡检 + 错误分析闭环 + Web GUI 工作台页。

安装后在 profile 中出现行 `workbench`（配置在 `cordis.patch.yml`）。P0 提供配置校验、七个存储域与可 inspect 的服务骨架；P2-P7 逐节补齐采集、分析、通知与 UI。

配置样例见仓根 `contracts/config.schema.json`；**凭据只认环境变量名**（`tokenEnv`），配置里出现 token 字面值会被拒绝。
