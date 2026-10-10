# 平台基础实现与验收记录

本轮交付代码与本地可执行构建，生产尚未升级。现有 Cloudflare URL 保持原运行版本；没有修改 Tailscale、代理或实际 launchd 服务。

## 已完成

- 平台 SQLite 与 Pi、独立验证器、业务数据库分离；旧任务映射导入，原生历史保留。
- 监控、长期任务、插件工作区重构；三类任务状态分开；人工验收保留依据与时间，新执行后不能沿用旧验收。
- manifest 注册、启禁、方法声明、工具幂等请求、隔离代理、插件事件、独立随手记业务。
- 独立采集器、持久事件、只读 Pi 诊断、具名动作代理、两次上限、独立 Pi 复核与固定功能/浏览器探针。
- 控制层和故障记录能在 Pi 离线时读取；模糊动作不自动重放；长采样间隔、未来/过期证据、禁用/撤销、版本/环境变化不能关闭事件。
- 生成六个独立 launchd 清单并经过 plutil 校验；生产升级保留已有配置和数据库。

## 自动验证

`npm test` 通过：原生 Pi 9 项；独立服务 8 项；Go 控制层 13 项；broker 6 项实质测试（另有 SIGKILL 子进程辅助入口）；前端 API 请求重试检查通过。真实 SQLite、文件操作、SIGKILL 和 HTTP 处理器被实际执行。独立模型流程测试使用可控 provider，证明工具范围与持久会话行为，没有把它称为真实 Engy 验收。

`npm run build` 通过，生成 React 生产文件、Node 执行器以及 Go control/broker 可执行文件。配置再次运行不覆盖原凭据，各服务 token 互异；安装清单校验通过。

## 未完成的运行验收

当前会话的文件系统只允许写 NOTE 和临时目录；目标仓库与 `/Library/Application Support/refbox` 不在可写范围。禁止在此环境安装/替换目标 daemon。

本地端口监听被拒绝（listen EPERM），Chromium 启动被拒绝（MachPortRendezvousServer Permission denied）。因此以下项目保留为待验收，不使用编译或进程内测试冒充它们：

- 真实 TCP 与完整跨进程故障服务闭环：恢复、两次失败后停止、Pi 离线、验证器/插件离线、平台重启。
- 真正的浏览器桌面/手机/键盘/鼠标，以及 iframe、状态更新、产物与汇报交互。
- 当前 Mac mini 新版 daemon 与真实 Engy 的独立复核。
- 实际 Cloudflare 用户入口的登录、渲染和恢复后的业务可用性。

## 在目标机器应用

源代码分支与补丁以原仓库当前提交为基础；不包含任何 `.env`、凭据、用户业务数据库、bootstrap 密码或系统密码。

1. 审阅 PR 或将补丁应用到干净目标工作树，保留现有生产和开发 var/config。
2. `npm ci && npm run configure && npm run build`；设置 `REFBOX_PUBLIC_URL=https://refbox.jeffkafka.top`，确认应用浏览器凭据有效；已有 Cloudflare 配置继续复用。
3. 备份当前生产 `.env` 与 var；`npm run prepare:daemon` 并生成安装清单。
4. 在可管理系统服务的会话中执行既有 launchd 安装命令；部署为用户决定，不能由监控 agent 自行升级平台。
5. 执行真实 TCP、浏览器及受控故障验收，检查证据和两次上限，再在相关 issue 上记录实际结果。

本次未关闭 UI、状态、Prove It、插件四项 issue；代码实现不等于已经通过线上使用验收。复杂业务客户端、插件市场、图编辑器、远程执行器选择与其他业务任务的自动验收适配器后续推进。
