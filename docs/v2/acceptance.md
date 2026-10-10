# 平台基础实现与验收记录

2026-10-10，PR #6 已部署到当前 Mac mini，实际入口为 https://refbox.jeffkafka.top。沿用既有 Cloudflare tunnel、配置、凭据和 DNS；相关三个配置文件 SHA-256 与部署前一致，没有操作 Tailscale 或代理。生产目录已备份到 `/Library/Application Support/refbox-backups/20261010-pr6/`（受保护的本机目录）。

## 已完成

- 平台 SQLite 与 Pi、独立验证器、业务数据库分离；旧任务映射导入，原生历史保留。
- 监控、长期任务、插件工作区重构；三类任务状态分开；人工验收保留依据与时间，新执行后不能沿用旧验收。
- manifest 注册、启禁、方法声明、工具幂等请求、隔离代理、插件事件、独立随手记业务。
- 独立采集器、持久事件、只读 Pi 诊断、具名动作代理、两次上限、独立 Pi 复核与固定功能/浏览器探针。
- 控制层和故障记录能在 Pi 离线时读取；模糊动作不自动重放；长采样间隔、未来/过期证据、禁用/撤销、版本/环境变化不能关闭事件。
- 生成六个独立 launchd 清单并经过 plutil 校验；生产升级保留已有配置和数据库。

## 自动验证

`npm test` 通过：原生 Pi 9 项；独立服务的功能、鉴权、持久化和独立会话测试；Go 控制层与 broker 的 race 测试；前端 API 请求重试检查通过。真实 SQLite、文件操作、SIGKILL、HTTP 处理器以及实际快照/事件流传输被执行。独立模型流程测试使用可控 provider，证明工具范围与持久会话行为，没有把它称为真实 Engy 验收。

`npm run build` 通过，生成 React 生产文件、Node 执行器以及 Go control/broker 可执行文件。配置再次运行不覆盖原凭据，各服务 token 互异；安装清单校验通过。

## 真实运行验收

- 部署审计通过：engine 与 broker 为 uid 0，其余四个服务为 uid 501。verifier 的 reviewerAvailable=true，独立数据库与浏览器可用；未授权及错误角色 token 均被拒绝。
- 原生任务 3、32 及实验、自检和汇报历史保留。原有已完成任务没有被升级为独立 pass。
- 真实 TCP 服务套件 13 项通过，覆盖功能故障、认证、独立会话、原始响应证据与实际监控序列；实际浏览器模拟 API 回归 5 项通过。
- 实际 Cloudflare 浏览器验收 2 项通过，覆盖历史产物、真实状态修改与刷新、拒绝未验证完成、人工验收、插件写入/读回/iframe/刷新、键盘、手机布局、退出与未登录拒绝；未出现页面 JavaScript 异常。详见 [界面记录](ui-live.md)。
- 隔离真实跨进程验收 8 项通过：HTTP 200 但业务故障、实际命名重启、三次健康采样、真实 Engy/kimi-k3 独立复核、Pi 与验证器离线、插件事件/禁用/离线、实际过期等待、两次上限、平台重启与动作幂等。fixture 只在普通用户的 GUI domain 重启，生产 root broker 权限由独立部署审计确认；不把两者混称。详见 [服务记录](live-services.md)。
- 生产独立 Prove It Worker 对实际 Cloudflare 入口执行固定 http_json、browser_ui 检查，附上三条真实连续监控记录、响应正文摘要/哈希、断言的实际值和浏览器可见文本，并由其独立 Pi 会话 35 给出 pass；该请求标记为部署验收，没有虚构生产故障事件。
- 真实 root Agent 任务 86 经计划、批准、实验与固定自检生成 `ROOT_VERIFIED_PR6`。退出码 0，已登记实际文件和工具证据，产物通过 Cloudflare 读回。执行结果标为 execution_assertion，检查后的业务闭合标为 manual，没有伪装成领域任务的独立证明。

原始本机证据保存在 `var/deployment-audit.json`、`var/cross-process-acceptance.json`、`var/cf-prove-evidence-final.json`、`var/root-task-acceptance.json`、`var/screenshots/live-ui-acceptance.json` 和实际截图。配置、密码、API Key 和数据库不提交仓库。

验收发现 macOS 已安装的 headless-shell 不能稳定启动，完整 Chromium channel 的实际渲染可用；测试与独立验证器改用该 channel。此前受限会话的编译与进程内测试没有被当作真实验收，本轮已补齐运行证据。

实际故障验收还复现了重启后的短暂失败会把事件从 proving 改回 diagnosing，随后业务恢复却不再自动验证的问题。编排器现会在这两种状态下对连续三次健康采样触发独立证明，已有针对该路径的回归测试。

线上复跑捕获一次真实 502，时间与平台自动重启 Cloudflare tunnel 一致。两次公网探测超时触发了该动作，但本地 connector 指标仍为两条连接。现有证据不足以授权这种重启，监控插件已改为默认 `restartAllowed:false`；`REFBOX_ALLOW_TUNNEL_RESTART=true` 才显式开启。保留公网故障、独立诊断和验收，不删除失败记录；没有重配 Cloudflare 或网络代理。对应本机诊断记录为 `var/live-gateway-diagnostics.json`。

随后复跑的状态接口返回 200，但每两秒传送完整 SSE 快照与串行刷新导致可见反馈超时：实测快照约 339 KB、读取需 6–22 秒。界面现直接采用服务器确认的状态，并行刷新快照和原生历史；快照/事件流传输增加压缩，内容不变时只发送心跳。新增浏览器测试挂住后续快照请求，仍须看到已确认的状态，不能把网络等待误报为状态保存失败。

最终线上快照实测 358128 字节压缩为 59463 字节，公开读取 200、约 1.2 秒；证据为 `var/live-transport-acceptance.json`。实际入口故障事件 `inc_c7f258ab3de436616b4ab728` 随后由独立 verifier conversation `112` 验证闭合：新的固定指标/公开 HTTP/真实浏览器检查通过，附有三条实际连续健康记录，`verification=pass`。此前两条格式不合规复核与一次探针超时的失败仍保留，记录为 `var/cf-live-incident-retry.json`；没有人为改写历史结论或追加重启。

## 在目标机器应用

源代码分支与补丁以原仓库当前提交为基础；不包含任何 `.env`、凭据、用户业务数据库、bootstrap 密码或系统密码。

1. 审阅 PR 或将补丁应用到干净目标工作树，保留现有生产和开发 var/config。
2. `npm ci && npm run configure && npm run build`；设置 `REFBOX_PUBLIC_URL=https://refbox.jeffkafka.top`，确认应用浏览器凭据有效；已有 Cloudflare 配置继续复用。
3. 备份当前生产 `.env` 与 var；`npm run prepare:daemon` 并生成安装清单。
4. 在可管理系统服务的会话中执行既有 launchd 安装命令；部署为用户决定，不能由监控 agent 自行升级平台。
5. 执行真实 TCP、浏览器及受控故障验收，检查证据和两次上限，再在相关 issue 上记录实际结果。

本轮完成平台基础的部署与上述真实验收。UI/UX 满意度、领域验证覆盖和横向规模仍按对应 issue 继续演化；不会把基础验收宣称为全部长期需求完成。复杂业务客户端、插件市场、图编辑器、远程执行器选择与其他业务任务的自动验收适配器后续推进。
