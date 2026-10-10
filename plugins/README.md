# 独立业务插件

插件入口是独立服务的 `/manifest`，不是跳转网址或核心程序中的条件分支。

- 家庭基础设施：`http://127.0.0.1:18811/manifest`，凭据环境变量 `REFBOX_MONITOR_TOKEN`。
- 个人随手记：`http://127.0.0.1:18813/manifest`，凭据环境变量 `REFBOX_SCRATCHPAD_TOKEN`。
- 隔离故障验收：`http://127.0.0.1:18815/manifest`，凭据环境变量 `REFBOX_FAULT_TOKEN`；仅用于测试，不加入真实机器的重启动作白名单。

两个正常插件拥有自己的业务工作区、数据、工具和事件，核心只保存注册、资源和事件索引。随手记的 `create-note` 工具输入 `{ "title": "标题", "content": "内容" }`，通过平台工具操作即可创建。工作区以隔离 HTML 展示业务数据，不获取平台管理员 Cookie。

监控插件保存自己的采样 SQLite。独立验证器不是插件数据表的一部分，拥有独立 Pi SQLite 和工具为空的独立复核会话。
