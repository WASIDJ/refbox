# 独立动作代理

`refbox-broker` 独立于 Pi 和 Go 工作台运行，默认监听 `127.0.0.1:18814`。平台使用独立的 `REFBOX_BROKER_TOKEN` 调用 `POST /restart`，body 仅接受 `{serviceId,actionId}`。

代理把服务 ID 映射为管理员配置的固定 launchctl 目标，直接执行 `/bin/launchctl kickstart -k domain/label`，最长 15 秒。没有 shell、任意命令、调用者提供的 label/domain 或临时提权参数。

默认允许 `engine`、`tunnel`、`monitor`、`verifier`，分别对应 `system/ai.refbox.{serviceId}`。默认拒绝 `control`：替换或重启正在运行的平台由人决定。显式管理员配置 `REFBOX_BROKER_SERVICES` 替换整个 allowlist，例如：

```json
{ "engine": { "domain": "system", "label": "ai.refbox.engine" } }
```

配置只能使用 `system`、`user/UID`、`gui/UID` domain 和 `ai.refbox.` 开头的固定 label。调用者没有配置修改接口。

## Durable action receipt

`REFBOX_BROKER_DATABASE` 默认 `var/broker.sqlite`，由 broker 独占其逻辑数据，使用 SQLite WAL 和 synchronous FULL。执行前提交 pending receipt；完成后记录实际结果。

- HTTP 200：已确认执行成功且完成回执已保存。
- HTTP 502：已确认操作失败；重复 actionId 返回同一个失败，不再次执行。
- HTTP 409 / inconclusive：动作正在执行或进程退出后结果不明确。重试相同 actionId 只读取回执，不重启。
- 相同 actionId 用于不同 serviceId：409；未知或未授权服务：403。

如果在执行后、回执完成前被 SIGKILL，pending receipt 在重启后保持不确定。平台应通过独立监控与 Prove It 确认实际状态，而不是自动重放动作。动作失败或结果未知都不代表业务验证通过。

broker 应由独立 launchd 服务以 root 运行；工作台无需 root，Pi 的既有已批准任务权限保持原样。代理仅监听 loopback，不直接发布到 Cloudflare Tunnel。生产安装由项目部署脚本处理，本测试不修改实际服务。

测试使用注入的 restart 函数，覆盖固定目标、鉴权、默认拒绝 control、并发／重开去重、完成回执写入失败，以及真实 SIGKILL 后不重放；测试不执行 launchctl。
