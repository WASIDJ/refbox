# 真实服务闭环验收

执行 `npm run build` 后，以普通 Mac 用户运行：

```sh
npm run test:services:tcp
node scripts/accept-platform.mjs
```

验收器在独立目录 `var/acceptance-<时间与随机后缀>/` 建立全新数据库和独立的临时应用密码与服务 token，端口为 `24800`、`24801`、`24811` 至 `24815`。可设置 `REFBOX_ACCEPT_PORT`、`REFBOX_ACCEPT_DIR`；默认检测当前用户已存在的 `gui/<uid>` domain；没有 GUI domain 时使用 `user/<uid>`，标签为随机 `ai.refbox.accept-fixture.*`。可设置 `REFBOX_ACCEPT_DOMAIN=gui/<uid>` 明确选择。不能指定其他用户或 system domain。

所有正常服务都是实际独立进程：Go 控制层、Go 命名动作 broker、Pi runtime、监控 collector、Prove It Worker、随手记。broker 使用生产实现的 `/bin/launchctl kickstart -k`，白名单仅包含验收器创建的临时 fixture 标签，不包含任何真实服务。故障 fixture 使用独立启动计数数据库，第一次启动业务损坏但仍 HTTP 200；真实重启后恢复。采集器通过真实 HTTP 功能探针每 500 毫秒采样，平台保持原本 5 秒编排周期。

独立验证器使用现有 `PI_PROFILE_DIR`（默认 `~/.pi/agent`）中的真实 Engy 凭据与 `kimi-k3`，创建自己的独立 Pi SQLite 和 conversation。脚本不使用 model mock，也不打印 API Key、应用密码或服务 token。实际模型审查失败或拒绝时，验收失败，不能被无条件当作通过。

验收覆盖：

- Pi 下线后，控制层、缓存的业务任务、监控与 SSE 仍然工作。
- 两次实际坏探针打开事件，命名重启，三次新鲜健康采样及真实独立模型证明才能闭合。
- 验证器下线时，业务恢复也不能关闭；恢复独立验证器后用新证明明确重试。
- 无关插件真实持久化数据、SSE 事件接入、禁用、离线仍保留工作区注册。
- 采集器下线 46 秒后，资源转为 stale。
- 业务持续故障时最多两次真实重启；停止自动动作并拒绝第三次。
- 平台进程重启后保留任务 ID、conversation 引用、证据与动作预算；broker 复用 actionId 不再重启。

每阶段进度显示为简短 JSON。完整结果写入 `report.json`，包含真实证明的 reviewConversationId、固定功能检查、事件/动作/版本/环境绑定与清理结果。`configuration.private.json` 和日志权限为 600；这是临时验收配置，不能复制到生产或公开。验收结束自动停止自己的进程和临时 launchctl 标签，保留数据与报告方便复核。

这个验收器不改变 Tailscale、Cloudflare 配置，也不对生产服务注入故障。公开 Cloudflare 路径和实际浏览器验收由部署后的 UI 测试补充，本脚本仅说明隔离环境中的真实跨进程闭环。

## 当前机器的实际结果

2026-10-10 运行通过全部八项真实场景，使用已发布的内部盘 Node 24、真实 Engy/kimi-k3 和当前用户 GUI domain。生产 root broker 的 uid=0 另由部署审计验证；隔离 fixture 重启本身以普通用户身份执行。没有对生产服务注入故障。

首次尝试 user/501 bootstrap 返回 I/O 错误，GUI/501 实际可用；验收器已自动选择存在的 GUI domain。报告须根据观察到的子进程退出和 launchctl 标签不存在确认清理，清理未确认会失败。事件开启前的两次失败由独立采集数据库中的真实功能样本证明，不能用已经重启替代该断言。

最终完整报告位于本机 `var/cross-process-acceptance.json`，运行时间为 2026-10-10 10:05:48–10:07:33 UTC，`status=passed`、八项场景全部通过。所有九次启动的子进程均确认退出，临时 fixture 标签确认移除，清理错误为空。两次通过的独立模型审查分别使用 verifier conversation `2` 和 `13`，原始证据随报告保留；验证器离线阶段的 `inconclusive` 记录也保留。

独立模型收到的功能检查包含实际 HTTP 状态、最多 4 KiB 的响应摘要、完整响应体 SHA-256，以及 JSON 字段或指标的实际观察值。它另行通过专用平台 token 读取三条真实监控记录，核对资源、版本、环境、连续健康及 45 秒新鲜窗口。监控记录允许早于本次验证请求；本次独立功能检查必须在请求之后执行。平台的整段连续健康计数与附上的三条最近记录分别显示，不能把一个计数当成三份证据。

部署后的公开路径另有真实证明：本机 `var/cf-prove-evidence-final.json` 的 verifier conversation `35` 判定 `pass`。它实际检查本地 `/health`、现有 `https://refbox.jeffkafka.top/health`，并通过真实 Chromium 登录公开页面、看到 `[data-resource-id="refbox-engine"]` 的“Pi 执行服务”文本。该证明保留最终 URL、导航状态、实际可见文本、响应摘要与哈希，绑定 `refbox-control`、版本 `2`、环境 `macmini-local`，并附上三次真实监控采样。公开 UI 的交互验收结果见 [真实界面验收](ui-live.md)。这些结果证明当时实际运行状态，不保证之后不会发生故障。
