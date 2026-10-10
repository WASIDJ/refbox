# Pi 执行器与平台诊断

Go 的平台任务有自己的 ID，以 `conversationId` 关联历史 Pi conversation。运行器仍然独占原生 Pi 数据库；不改变历史 BoardDoc 的格式，不把业务插件的数据复制进执行库。

配置 `REFBOX_PLATFORM_URL=http://127.0.0.1:8080` 与独立的 `REFBOX_PLATFORM_TOKEN` 后，已批准的常规任务获得平台资源／插件发现、只读工具和声明工具调用能力。工具目标只能由 Go 注册表解析；模型不能提供目标 URL。只读调用在运行器和 Go 两侧依据 manifest 的 `mutates:false` 验证。可变更调用必须处于已批准、正在运行的普通任务，仍受平台插件和预授权操作的约束。

## 只读故障诊断

- `POST /api/diagnoses` 接受 `{incidentId,resourceId,actionId?,version,environmentId,observations?,context?,model?}`，携带内部执行凭据和 `Idempotency-Key`。
- 返回 `{id,conversationId,status,summary,createdAt,updatedAt,...资源绑定字段}`；`GET /api/diagnoses/{id}` 查询持久状态。
- 每次诊断创建单独的原生 ownerless conversation，用独立 DiagnosticsDoc 保存请求回执和最终结论，不创建普通任务卡。
- 只提供 `platform_observe` 和 `platform_read_tool`。没有 CodingTools、shell、文件写入、重启和可变更插件工具；工具 hook 还会独立拒绝恶意调用。
- 观察限定于目标资源，只读插件工具限定于该资源所属插件；输入中的 `resourceId` 强制使用诊断目标。诊断叙述不作为修复验收结论，不改变事件或健康状态。
- 原生请求标识用于重开恢复和重复提交去重；异常结束呈现 `interrupted`，不会伪造诊断完成。

平台提供 `/internal/resources`、`/internal/plugins`、`/internal/observations?resourceId=...` 和 `/internal/plugins/{pluginId}/tools/{toolId}`。执行器调用工具的 body 为 `{input,readOnly,resourceId?}`；诊断始终发送 `readOnly:true`。

工具调用额外携带宿主生成的 `_idempotencyKey:pi-tool:<原生 callId>`，由 Go 移除该内部字段并转为下游 `Idempotency-Key`。调用者输入不能覆盖这个键。可变更工具仍不声明 replay-safe；如果业务插件未实现去重，不能把传递请求键理解为可安全重复执行。

## 自检与健康

历史 `verify_result` 和完整授权工具保持可用。新验证记录标记 `assurance:execution_assertion`，新汇报称为执行侧自检。退出码成功结束原生执行会话，不能独自把平台业务任务标记已验收完成。

`GET /api/health` 增加 `readiness`、`activeRuns`、`lastProgressAt` 和 `platformConfigured`。进展时间仅来自模型响应／工具结果；它不是模型可用性或业务健康证明。平台与监控插件独立运行，执行器离线不影响监控或预授权恢复。
