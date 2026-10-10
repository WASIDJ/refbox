# 独立监控、验证和业务服务

这几个服务都只监听 loopback，作为普通用户运行，拥有不同服务凭据。Pi 执行服务和命名动作 broker 可以使用已批准的权限；监控与验证服务不获得 shell 工具。证明者是同一台机器上的角色独立，不能保证抵抗拥有 root 的恶意执行者篡改。

| 服务                 | 默认端口 | 数据归属                                        | 凭据                      |
| -------------------- | -------- | ----------------------------------------------- | ------------------------- |
| 独立监控插件         | 18811    | `var/monitor.sqlite`，最近 5000 条真实采样      | `REFBOX_MONITOR_TOKEN`    |
| 独立 Prove It Worker | 18812    | `var/verifier.sqlite`，独立 Pi 会话与模型用量   | `REFBOX_VERIFIER_TOKEN`   |
| 随手记业务插件       | 18813    | `var/scratchpad.sqlite`，业务笔记与幂等写入记录 | `REFBOX_SCRATCHPAD_TOKEN` |
| 可控故障验收服务     | 18815    | 仅测试使用的启动计数数据库                      | `REFBOX_FAULT_TOKEN`      |

`REFBOX_PLATFORM_TOKEN` 用于采集器和验证器访问 Go 平台的内部资源与心跳接口。不要把它复用为插件凭据。所有 token 至少 32 字符，不在工作区 HTML、manifest 或日志中暴露。

## 启动与注册

完成配置和构建后执行 `node scripts/start-services.mjs`。这个前台开发启动器从 `.env` 读取数据配置，分别启动监控、验证、随手记进程；生产由独立 launchd label 监督进程。启动器不安装系统守护进程，不使用 sudo，不重启真实业务服务。

在平台注册监控 manifest `http://127.0.0.1:18811/manifest`，凭据环境变量 `REFBOX_MONITOR_TOKEN`；再注册随手记 `http://127.0.0.1:18813/manifest`，凭据环境变量 `REFBOX_SCRATCHPAD_TOKEN`。平台进程与两个插件进程各自需要持有对应环境变量。核心代理使用单独插件 Bearer 凭据，不传递管理员 Cookie。

可配置 `REFBOX_PLATFORM_URL`、`REFBOX_ENGINE_URL`、`REFBOX_TUNNEL_METRICS_URL`、`REFBOX_PUBLIC_URL`、`REFBOX_ENVIRONMENT_ID`，以及各服务的 `*_PORT` 和 `*_DATABASE`。数据库路径应放在 Mac mini 内部磁盘已配置的应用数据目录。验证器沿用 `PI_PROFILE_DIR` 的 Engy 模型配置与 `REFBOX_MODEL`（默认 `kimi-k3`），但数据库和 conversation 与执行者分开。

## 固定功能采样

每 15 秒从 Go `/internal/resources` 读取当前注册资源，执行固定的 HTTP body、JSON 路径或 Prometheus 指标断言，把方法、结果、采样时间、资源版本和环境回报平台。HTTP 200 本身没有证明力；例如 `cloudflared_tunnel_ha_connections >= 1` 才说明连接存在。采集器不调用 Pi，也不执行修复命令，Pi 下线不影响采集。

默认监控 Mac mini 的真实机器指标，Pi 的实际健康接口，Go 控制层的独立健康接口，以及 Cloudflare 实际连接数。配置 public URL 后，控制和入口资源的固定检查增加部署后的用户路径。资源修复权限只声明为命名 service ID `engine`、`control`、`tunnel`；其对应的固定 launchd 标签与最多两次修复限制由平台和 broker 控制。

采样存入监控插件自己的 SQLite；平台管理健康趋势、事件和闭合状态，两者不共用表。

诊断使用 `GET /samples?resourceId=...` 仅读取指定资源的采样，查询错误或空 scope 返回 400；未提供 scope 的平台总览可以读取全部采样。被禁用插件的资源明确标记 `enabled:false` 后不再探测，其他资源继续采集。

## 独立证明

验证器 `/verify` 只接受自己的 Bearer token。收到请求后重新读取平台注册标准，拒绝调用方替换 check、资源版本或环境。它执行新探针，确认至少三次**平台已有的**连续健康采样，再创建独立 Pi 会话供模型只读复核。调用方声称的 `healthySamples` 不被当作依据。复核期间资源变更、样本过时、模型超时、无效 JSON、缺少会话来源都会保持 `inconclusive`；固定功能检查失败或模型明确拒绝是 `fail`。

通过条件是固定功能断言全部通过、样本新鲜且连续健康、独立模型返回明确同意。证据包含 resource/incident/action/version/environment、每个检查的时间与方法，以及独立 reviewConversationId。会话持久化，模型没有 CodingTools 或 ExecutionEnv。核心再把返回证据绑定到动作与事件，判断是否可以关闭。

`check.browser` 是固定的真实 UI 标准，包含 `selector`、可选 `text` 和可选 `passwordEnv`。它通过独立 Playwright context 访问实际部署 URL 并检查渲染后的元素。已登录控制层的标准选择器是 `[data-testid="platform-shell"]`。`REFBOX_VERIFY_PASSWORD` 是专用于验证器的**应用登录凭据**，不是系统 root 密码。缺少该凭据、浏览器或模型时不会自动通过。测试可通过 `npx playwright install chromium` 在允许联网和安装的环境准备浏览器。浏览器标准与 HTTP 标准必须分成不同 check，不能混在一个 check 里。

## 随手记插件验证横向扩展

随手记保存、列出笔记，提供 `note.created` SSE 事件、自己的 SQLite 健康检查和隔离 HTML 工作区。创建工具输入 `{"title":"标题","content":"内容"}`，支持 Idempotency-Key。创建后刷新工作区显示实际持久化结果。它与机器监控没有业务关系，也没有增加核心数据库中的笔记表，说明插件扩展不会把业务表耦合进平台。

## 验收与限制

无网络测试：`node --test apps/services/test/in-process.test.mjs`，调用真实 Node 服务路由，覆盖鉴权、SQLite 重启、幂等写入、SSE、200 但业务坏、独立采集和不允许虚假通过。独立 Pi SQLite 与过时证据测试：`node --test --test-name-pattern='real Pi Durable|verifier cannot reuse' apps/services/test/services.test.mjs`。

真实 TCP 集成测试：`node --test apps/services/test/services.test.mjs`。当前执行沙箱禁止 loopback 监听（`listen EPERM`），因此 TCP 和真实浏览器验收需要在允许监听的目标环境完成。进程内路由测试通过不能替代部署后端到端验收。

隔离故障 fixture 永远不调用 launchctl，不作为真实机器修复白名单。默认第一次启动业务损坏但 HTTP 200；重启后独立业务恢复，启动次数保存在数据库中。`REFBOX_FAULT_MODE=always-broken` 可验证达到两次修复限制后仍不恢复的路径。
