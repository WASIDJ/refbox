import { useDeferredValue, useEffect, useState, type FormEvent } from "react";
import { api, relativeTime, timestamp } from "./api";
import { Badge, Empty, Icon, Modal, StatusTriple } from "./components";
import TaskDetail from "./TaskDetail";
import {
  emptySnapshot,
  type Evidence,
  type Plugin,
  type Snapshot,
  type Task,
  type Tool,
} from "./types";

const sections = {
  home: "Homelab",
  tasks: "长期任务",
  plugins: "插件管理",
  workspace: "业务工作区",
};
const businessColumns = [
  ["backlog", "待安排"],
  ["active", "进行中"],
  ["attention", "需要处理"],
  ["done", "已完成"],
];

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  return (
    <article className="evidence-card">
      <div className="section-heading">
        <Badge state={evidence.verdict} />
        <span className="muted">{timestamp(evidence.at)}</span>
      </div>
      <p>{evidence.summary}</p>
      <details>
        <summary>查看检查与溯源</summary>
        <dl className="key-values">
          <div>
            <dt>资源</dt>
            <dd>{evidence.resourceId}</dd>
          </div>
          <div>
            <dt>动作</dt>
            <dd>{evidence.actionId || "未执行修复"}</dd>
          </div>
          <div>
            <dt>版本 / 环境</dt>
            <dd>
              {evidence.version} / {evidence.environmentId}
            </dd>
          </div>
          <div>
            <dt>独立审查会话</dt>
            <dd>{evidence.reviewConversationId || "尚无模型审查"}</dd>
          </div>
        </dl>
        {(evidence.checks ?? []).map((check) => (
          <div className="proof-check" key={check.id}>
            <div>
              <strong>{check.id}</strong>
              <Badge
                state={check.passed ? "pass" : "fail"}
                text={check.passed ? "检查通过" : "检查未通过"}
              />
            </div>
            <p>{check.detail}</p>
            <p className="muted break-word">
              {check.url} · {timestamp(check.sampledAt)}
            </p>
          </div>
        ))}
        {evidence.review && <pre>{evidence.review}</pre>}
      </details>
    </article>
  );
}

function PluginTools({
  plugin,
  onResult,
  perform,
  pending,
}: {
  plugin: Plugin;
  onResult: () => void;
  perform: (
    operation: () => Promise<unknown>,
    success?: string,
  ) => Promise<boolean>;
  pending: boolean;
}) {
  const [selected, setSelected] = useState(plugin.manifest.tools[0]?.id ?? ""),
    [input, setInput] = useState("{}"),
    [output, setOutput] = useState("");
  const tools = plugin.manifest.tools ?? [],
    tool = tools.find((candidate) => candidate.id === selected);
  async function invoke(event: FormEvent) {
    event.preventDefault();
    const success = await perform(async () => {
      let body: unknown;
      try {
        body = JSON.parse(input);
      } catch {
        throw new Error("工具参数必须是有效的 JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("工具参数必须是 JSON 对象");
      const result = await api<unknown>(
        `/platform/plugins/${encodeURIComponent(plugin.id)}/tools/${encodeURIComponent(selected)}`,
        body,
      );
      setOutput(JSON.stringify(result, null, 2));
    }, "工具已执行，工作区内容已刷新");
    if (success) onResult();
  }
  if (!tools.length) return null;
  return (
    <details className="plugin-tools">
      <summary>
        插件工具 <span className="muted">{tools.length} 项能力</span>
      </summary>
      <form onSubmit={invoke}>
        <label>
          选择工具
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {tools.map((item: Tool) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {tool && (
          <p>
            {tool.description}
            {tool.mutates && (
              <span className="muted"> · 将修改插件业务数据</span>
            )}
          </p>
        )}
        <label>
          工具参数（JSON）
          <textarea
            className="code"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            required
          />
        </label>
        <button
          className="primary"
          disabled={pending || !plugin.enabled || !plugin.online || !tool}
        >
          执行工具
        </button>
      </form>
      {output && <pre aria-label="工具结果">{output}</pre>}
    </details>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [password, setPassword] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot),
    [connected, setConnected] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<keyof typeof sections>("home"),
    [workspaceId, setWorkspaceId] = useState(""),
    [frameVersion, setFrameVersion] = useState(0);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [pending, setPending] = useState(false);
  const [modal, setModal] = useState<"" | "task" | "plugin">(""),
    [selectedTask, setSelectedTask] = useState(""),
    [selectedIncident, setSelectedIncident] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [search, setSearch] = useState("");
  const [newTask, setNewTask] = useState({
    title: "",
    goal: "",
    cwd: "",
    model: "kimi-k3",
  });
  const [manifestUrl, setManifestUrl] = useState(""),
    [credentialEnv, setCredentialEnv] = useState("");
  const query = useDeferredValue(search).toLowerCase();
  const task = snapshot.tasks.find((item) => item.id === selectedTask),
    incident = snapshot.incidents.find((item) => item.id === selectedIncident),
    plugin = snapshot.plugins.find((item) => item.id === workspaceId);
  const incidentResource = snapshot.resources.find(
    (resource) => resource.id === incident?.resourceId,
  );
  const openIncidents = snapshot.incidents.filter(
    (item) => item.status !== "closed",
  );
  const tasks = snapshot.tasks.filter((item) =>
    `${item.title} ${item.goal}`.toLowerCase().includes(query),
  );
  async function refresh() {
    const data = await api<Snapshot>("/platform/snapshot");
    setSnapshot(data);
    setLoaded(true);
  }
  useEffect(() => {
    const expired = () => {
      setAuthenticated(false);
      setSelectedTask("");
      setSelectedIncident("");
      setModal("");
    };
    window.addEventListener("refbox:unauthorized", expired);
    api<{ authenticated: boolean }>("/session")
      .then((session) => setAuthenticated(session.authenticated))
      .catch(() => setAuthenticated(false));
    return () => window.removeEventListener("refbox:unauthorized", expired);
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    void refresh().catch((cause) => {
      if (active) setError((cause as Error).message);
    });
    void api<typeof models>("/models")
      .then((data) => {
        if (active) setModels(data);
      })
      .catch(() => {});
    const stream = new EventSource("/api/platform/events");
    stream.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as Snapshot;
        if (active) {
          setSnapshot(data);
          setConnected(true);
          setLoaded(true);
        }
      } catch {
        if (active) setError("实时状态无法读取，正在重新同步");
      }
    });
    stream.onerror = () => {
      if (active) setConnected(false);
    };
    const timer = setInterval(
      () => void refresh().catch(() => setConnected(false)),
      15000,
    );
    return () => {
      active = false;
      stream.close();
      clearInterval(timer);
      setConnected(false);
    };
  }, [authenticated]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  async function perform(
    operation: () => Promise<unknown>,
    success?: string,
    refreshAfter = true,
  ) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
      if (authenticated && refreshAfter) await refresh();
      if (success) setMessage(success);
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    await perform(
      async () => {
        await api("/login", { password });
        setPassword("");
        setAuthenticated(true);
      },
      undefined,
      false,
    );
  }
  async function logout() {
    await perform(
      async () => {
        await api("/logout", {});
        setAuthenticated(false);
        setSnapshot(emptySnapshot);
        setSelectedTask("");
        setSelectedIncident("");
      },
      undefined,
      false,
    );
  }
  async function createTask(event: FormEvent) {
    event.preventDefault();
    const success = await perform(async () => {
      const result = await api<Task>("/platform/tasks", newTask);
      setSelectedTask(result.id);
      setModal("");
      setTab("tasks");
    }, "任务已创建，可以让 Agent 制定计划");
    if (success) setNewTask({ title: "", goal: "", cwd: "", model: "kimi-k3" });
  }
  async function registerPlugin(event: FormEvent) {
    event.preventDefault();
    const success = await perform(async () => {
      await api("/platform/plugins", {
        manifestUrl,
        ...(credentialEnv ? { credentialEnv } : {}),
      });
      setModal("");
    }, "插件已注册，能力清单已载入");
    if (success) {
      setManifestUrl("");
      setCredentialEnv("");
    }
  }
  const changeTab = (next: keyof typeof sections) => {
    setTab(next);
    setError("");
    setMessage("");
  };
  if (authenticated === null)
    return (
      <main className="login-page">
        <div className="login-box">
          <span className="brand">
            refbox<span>.</span>
          </span>
          <p role="status">正在连接工作台…</p>
        </div>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login-page">
        <section className="login-box">
          <span className="brand">
            refbox<span>.</span>
          </span>
          <p className="eyebrow">个人 HOMELAB</p>
          <h1>进入你的工作台</h1>
          <p className="muted">运行 Agent，连接服务，查看可以验证的成果。</p>
          <form onSubmit={login} data-testid="login-form">
            <label>
              管理员密码
              <input
                autoFocus
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={pending}>
              {pending ? "正在登录…" : "进入 refbox"}
            </button>
          </form>
        </section>
      </main>
    );
  return (
    <div className="platform-shell" data-testid="platform-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">
            refbox<span>.</span>
          </span>
          <span className="muted">自指引擎</span>
        </div>
        <nav aria-label="主要导航">
          {(
            [
              ["home", "home"],
              ["tasks", "tasks"],
              ["plugins", "plugins"],
            ] as const
          ).map(([id, icon]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => changeTab(id)}
            >
              <Icon name={icon} />
              <span>{sections[id]}</span>
              {id === "home" && openIncidents.length > 0 && (
                <span className="nav-count">{openIncidents.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="workspace-nav">
          <p className="eyebrow">业务工作区</p>
          {snapshot.plugins
            .filter((item) => item.enabled)
            .map((item) => (
              <button
                key={item.id}
                aria-current={
                  tab === "workspace" && workspaceId === item.id
                    ? "page"
                    : undefined
                }
                onClick={() => {
                  setWorkspaceId(item.id);
                  changeTab("workspace");
                }}
              >
                <span
                  className={`workspace-dot ${item.online ? "is-online" : ""}`}
                />
                <span>{item.workspace.title || item.name}</span>
              </button>
            ))}
          {!snapshot.plugins.some((item) => item.enabled) && (
            <p className="muted nav-empty">注册插件以添加业务工作区</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <span className={`connection ${connected ? "connected" : ""}`}>
            <span className="status-dot" />
            {connected ? "实时连接" : loaded ? "已同步，重连中" : "连接中"}
          </span>
          <button onClick={() => void logout()} disabled={pending}>
            退出登录
          </button>
        </div>
      </aside>
      <main id="main" className="main-content">
        <header className="topbar" aria-busy={pending}>
          <span>
            个人 Homelab{" "}
            <span className="muted">
              /{" "}
              {tab === "workspace"
                ? (plugin?.workspace.title ?? "业务工作区")
                : sections[tab]}
            </span>
          </span>
          <button
            className="refresh-button"
            onClick={() => void perform(refresh, "状态已刷新")}
            disabled={pending}
          >
            <Icon name="refresh" />
            <span>刷新</span>
          </button>
          <button
            className="mobile-logout"
            onClick={() => void logout()}
            disabled={pending}
          >
            退出
          </button>
        </header>
        <div className="page-heading">
          <div>
            <h1>
              {tab === "workspace"
                ? (plugin?.workspace.title ?? "业务工作区")
                : sections[tab]}
            </h1>
            <p className="muted">
              {tab === "home"
                ? "关注服务状态、修复进展和验证证据。"
                : tab === "tasks"
                  ? "长期目标持续推进，执行记录和独立验证分别呈现。"
                  : tab === "plugins"
                    ? "每项业务保留自己的服务和数据，通过声明的能力接入工作台。"
                    : plugin?.description}
            </p>
          </div>
          {tab === "tasks" && (
            <button className="primary" onClick={() => setModal("task")}>
              <Icon name="plus" />
              新建目标
            </button>
          )}
          {tab === "plugins" && (
            <button className="primary" onClick={() => setModal("plugin")}>
              <Icon name="plus" />
              注册插件
            </button>
          )}
        </div>
        {pending && (
          <p className="notice" role="status">
            正在处理请求…
          </p>
        )}
        {error && !selectedIncident && !modal && (
          <div className="notice error" role="alert">
            {error}
            <button
              className="icon-button"
              aria-label="关闭错误"
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {message && (
          <p className="notice success" role="status">
            {message}
          </p>
        )}
        {!loaded && (
          <p className="notice" role="status">
            正在加载平台状态…
          </p>
        )}
        {tab === "home" && (
          <>
            <section className="overview-stats" aria-label="概览">
              <div>
                <span>需要处理</span>
                <strong>
                  {openIncidents.length}
                  <small>起事件</small>
                </strong>
              </div>
              <div>
                <span>健康资源</span>
                <strong>
                  {
                    snapshot.resources.filter(
                      (resource) => resource.health === "healthy",
                    ).length
                  }
                  <small>/ {snapshot.resources.length}</small>
                </strong>
              </div>
              <div>
                <span>持续运行</span>
                <strong>
                  {
                    snapshot.tasks.filter(
                      (item) => item.executionStatus === "running",
                    ).length
                  }
                  <small>个任务</small>
                </strong>
              </div>
              <div>
                <span>业务插件</span>
                <strong>
                  {snapshot.plugins.filter((item) => item.enabled).length}
                  <small>已启用</small>
                </strong>
              </div>
            </section>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>机器与服务</h2>
                  <p className="muted">
                    样本超过 45 秒标记过期，健康不代表事件已通过验证。
                  </p>
                </div>
                <span className="count">{snapshot.resources.length}</span>
              </div>
              {snapshot.resources.length ? (
                <div className="resources">
                  <div className="resource-table-head">
                    <span>资源</span>
                    <span>健康状态</span>
                    <span>最近观测</span>
                    <span>当前情况</span>
                  </div>
                  {snapshot.resources.map((resource) => (
                    <article
                      className="resource-row"
                      key={resource.id}
                      data-resource-id={resource.id}
                    >
                      <div className="resource-name">
                        <h3>{resource.name}</h3>
                        <span className="muted">
                          {resource.kind} · {resource.environmentId}
                        </span>
                      </div>
                      <div>
                        <Badge state={resource.health} />
                        <p className="muted">
                          {resource.health === "healthy"
                            ? `${resource.healthySamples} 个连续健康样本`
                            : resource.failures
                              ? `${resource.failures} 次连续失败`
                              : "等待有效观测"}
                        </p>
                      </div>
                      <div>
                        <strong>{relativeTime(resource.sampledAt)}</strong>
                        <p className="muted">
                          {resource.method || "观测方法未报告"}
                        </p>
                        <time className="muted" dateTime={resource.sampledAt}>
                          {timestamp(resource.sampledAt)}
                        </time>
                      </div>
                      <div>
                        <p className="resource-detail">
                          {resource.detail || "尚无观测结果"}
                        </p>
                        {openIncidents
                          .filter((item) => item.resourceId === resource.id)
                          .map((item) => (
                            <button
                              className="text-button"
                              key={item.id}
                              onClick={() => setSelectedIncident(item.id)}
                            >
                              处理事件 <Icon name="arrow" />
                            </button>
                          ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty title="尚无受监控资源">
                  注册监控插件后，资源与观测会显示在这里。
                </Empty>
              )}
            </section>
            <div className="home-grid">
              <section className="panel">
                <div className="section-heading">
                  <h2>修复事件</h2>
                  <span className="count">{openIncidents.length} 待处理</span>
                </div>
                {snapshot.incidents.length ? (
                  <div className="incident-list">
                    {[...snapshot.incidents]
                      .sort(
                        (a, b) =>
                          Number(a.status === "closed") -
                            Number(b.status === "closed") ||
                          b.updatedAt.localeCompare(a.updatedAt),
                      )
                      .slice(0, 12)
                      .map((item) => (
                        <button
                          className="incident-card"
                          key={item.id}
                          onClick={() => {
                            setError("");
                            setSelectedIncident(item.id);
                          }}
                        >
                          <div className="section-heading">
                            <strong>
                              {snapshot.resources.find(
                                (resource) => resource.id === item.resourceId,
                              )?.name ?? item.resourceId}
                            </strong>
                            <Badge state={item.status} />
                          </div>
                          <p>{item.reason || "正在收集诊断信息"}</p>
                          <div className="incident-meta">
                            <span>重启 {item.attempts} / 2 次</span>
                            <Badge state={item.verification} />
                            <span>{timestamp(item.updatedAt)}</span>
                          </div>
                        </button>
                      ))}
                  </div>
                ) : (
                  <Empty title="暂无修复事件">
                    连续两次观测失败后会创建事件。
                  </Empty>
                )}
              </section>
              <section className="panel">
                <div className="section-heading">
                  <h2>运行角色</h2>
                </div>
                <p className="muted">
                  控制、监控、执行和验证分别保持自己的运行状态。
                </p>
                {snapshot.workers.length ? (
                  <div className="worker-list">
                    {snapshot.workers.map((worker) => (
                      <article className="worker-row" key={worker.id}>
                        <div>
                          <h3>
                            {{
                              monitor: "监控采集",
                              prover: "独立验证",
                              executor: "Agent 执行",
                              broker: "授权动作",
                            }[worker.role] ?? worker.role}
                          </h3>
                          <p className="muted">{worker.detail || worker.id}</p>
                          <span className="muted">
                            {relativeTime(worker.lastSeen)}
                          </span>
                        </div>
                        <Badge state={worker.status} />
                      </article>
                    ))}
                  </div>
                ) : (
                  <Empty title="等待运行角色注册" />
                )}
              </section>
            </div>
            <section className="panel">
              <div className="section-heading">
                <h2>最近活动</h2>
              </div>
              {snapshot.events.length ? (
                <ol className="activity-list">
                  {[...snapshot.events]
                    .sort((a, b) => b.at.localeCompare(a.at))
                    .slice(0, 10)
                    .map((event) => (
                      <li key={event.id}>
                        <time dateTime={event.at}>{timestamp(event.at)}</time>
                        <span>{event.message}</span>
                      </li>
                    ))}
                </ol>
              ) : (
                <p className="muted">尚无平台活动。</p>
              )}
            </section>
          </>
        )}
        {tab === "tasks" && (
          <>
            <div className="task-toolbar">
              <label className="search-label">
                搜索任务
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="名称或目标"
                />
              </label>
              <span className="muted">{tasks.length} 个目标</span>
            </div>
            <div className="kanban">
              {businessColumns.map(([state, name]) => (
                <section className="kanban-column" key={state}>
                  <div className="column-heading">
                    <h2>{name}</h2>
                    <span className="count">
                      {
                        tasks.filter((item) => item.businessStatus === state)
                          .length
                      }
                    </span>
                  </div>
                  {tasks
                    .filter((item) => item.businessStatus === state)
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((item) => (
                      <button
                        className="task-card"
                        key={item.id}
                        onClick={() => setSelectedTask(item.id)}
                      >
                        <h3>{item.title}</h3>
                        <p>{item.goal}</p>
                        <StatusTriple
                          business={item.businessStatus}
                          execution={item.executionStatus}
                          proof={item.verificationStatus}
                        />
                        {!item.engineAvailable && (
                          <span className="offline-note">执行服务离线</span>
                        )}
                        <div className="card-meta">
                          <span>{item.model}</span>
                          <time dateTime={item.updatedAt}>
                            {timestamp(item.updatedAt)}
                          </time>
                        </div>
                      </button>
                    ))}
                  {!tasks.some((item) => item.businessStatus === state) && (
                    <p className="column-empty">暂无目标</p>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
        {tab === "plugins" && (
          <>
            <div className="plugin-grid">
              {snapshot.plugins.map((item) => (
                <article className="panel plugin-card" key={item.id}>
                  <div className="section-heading">
                    <h2>{item.name}</h2>
                    <Badge
                      state={
                        item.enabled
                          ? item.online
                            ? "online"
                            : "offline"
                          : "stopped"
                      }
                      text={
                        item.enabled
                          ? item.online
                            ? "在线"
                            : "离线"
                          : "已停用"
                      }
                    />
                  </div>
                  <p>{item.description}</p>
                  <p className="muted">
                    版本 {item.version} · {item.id}
                  </p>
                  {item.error && <p className="notice warning">{item.error}</p>}
                  <dl className="plugin-capabilities">
                    <div>
                      <dt>资源</dt>
                      <dd>{item.manifest.resources?.length ?? 0}</dd>
                    </div>
                    <div>
                      <dt>工具</dt>
                      <dd>{item.manifest.tools?.length ?? 0}</dd>
                    </div>
                    <div>
                      <dt>事件</dt>
                      <dd>{item.manifest.events?.length ?? 0}</dd>
                    </div>
                    <div>
                      <dt>验证项</dt>
                      <dd>{item.manifest.verification?.checks?.length ?? 0}</dd>
                    </div>
                  </dl>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={!item.enabled || !item.online}
                      onClick={() => {
                        setWorkspaceId(item.id);
                        changeTab("workspace");
                      }}
                    >
                      打开工作区
                    </button>
                    <button
                      disabled={pending}
                      onClick={() =>
                        void perform(
                          () =>
                            api(
                              `/platform/plugins/${encodeURIComponent(item.id)}/enable`,
                              { enabled: !item.enabled },
                            ),
                          item.enabled ? "插件已停用" : "插件已启用",
                        )
                      }
                    >
                      {item.enabled ? "停用插件" : "启用插件"}
                    </button>
                  </div>
                  <details>
                    <summary>能力清单</summary>
                    <p className="muted break-word">{item.manifestUrl}</p>
                    {item.manifest.tools?.map((tool) => (
                      <p key={tool.id}>
                        <strong>{tool.name}</strong> — {tool.description}
                      </p>
                    ))}
                    <pre>{JSON.stringify(item.manifest, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </div>
            {!snapshot.plugins.length && (
              <Empty title="添加你的第一个业务插件">
                插件声明工作区、资源、工具、事件和验证项。可以先接入监控或个人便笺服务。
              </Empty>
            )}
          </>
        )}
        {tab === "workspace" &&
          (plugin ? (
            <section className="plugin-workspace">
              <div className="workspace-info">
                <Badge state={plugin.online ? "online" : "offline"} />
                <span className="muted">
                  {plugin.name} · v{plugin.version}
                </span>
                <button
                  disabled={pending || !plugin.online}
                  onClick={() => setFrameVersion((version) => version + 1)}
                >
                  刷新工作区
                </button>
              </div>
              {plugin.enabled && plugin.online ? (
                <iframe
                  key={`${plugin.id}:${frameVersion}`}
                  title={plugin.workspace.title || plugin.name}
                  src={`/api/platform/plugins/${encodeURIComponent(plugin.id)}/proxy/${plugin.workspace.path.replace(/^\//, "")}`}
                  sandbox="allow-scripts allow-forms"
                />
              ) : (
                <p className="notice warning">
                  {plugin.enabled
                    ? "插件离线，业务数据仍由插件服务保存。恢复服务后刷新。"
                    : "插件已停用，可在插件管理中启用。"}
                  {plugin.error && ` ${plugin.error}`}
                </p>
              )}
              <PluginTools
                key={plugin.id}
                plugin={plugin}
                pending={pending}
                perform={perform}
                onResult={() => setFrameVersion((version) => version + 1)}
              />
            </section>
          ) : (
            <Empty title="工作区暂不可用">
              请在插件管理中选择一个已启用的插件。
            </Empty>
          ))}
      </main>
      {task && (
        <TaskDetail
          key={task.id}
          task={task}
          refresh={refresh}
          onClose={() => setSelectedTask("")}
        />
      )}
      {incident && (
        <Modal
          title="修复事件"
          onClose={() => {
            setSelectedIncident("");
            setError("");
          }}
          wide
        >
          <div className="incident-title">
            <h3>{incidentResource?.name ?? incident.resourceId}</h3>
            <div className="button-row">
              <Badge state={incident.status} />
              <Badge state={incident.verification} />
              <span>重启 {incident.attempts} / 2 次</span>
            </div>
            <p>{incident.reason || "等待诊断结果"}</p>
          </div>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="notice success" role="status">
              {message}
            </p>
          )}
          <ol className="repair-flow" aria-label="修复流程">
            {[
              ["diagnosing", "诊断"],
              ["acting", "授权修复"],
              ["proving", "独立验证"],
              ["closed", "关闭事件"],
            ].map(([id, name]) => (
              <li key={id} className={incident.status === id ? "current" : ""}>
                {name}
              </li>
            ))}
          </ol>
          <p className="muted">
            最多两次授权重启。恢复需要三个连续健康样本与业务检查通过，证据不足会保留事件。
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={
                pending ||
                incident.attempts >= 2 ||
                incident.status === "closed" ||
                !incidentResource?.restartAllowed
              }
              onClick={() =>
                void perform(
                  () =>
                    api(
                      `/platform/incidents/${encodeURIComponent(incident.id)}/repair`,
                      {},
                    ),
                  "已请求授权修复",
                )
              }
            >
              重启服务并检查
            </button>
            <button
              disabled={pending || incident.status === "closed"}
              onClick={() =>
                void perform(
                  () =>
                    api(
                      `/platform/incidents/${encodeURIComponent(incident.id)}/verify`,
                      {},
                    ),
                  "已请求独立验证",
                )
              }
            >
              重新验证
            </button>
            <button
              disabled={pending || incident.status === "closed"}
              onClick={() =>
                void perform(
                  () =>
                    api(
                      `/platform/incidents/${encodeURIComponent(incident.id)}/diagnose`,
                      {},
                    ),
                  "已请求 Agent 诊断",
                )
              }
            >
              继续诊断
            </button>
          </div>
          {incident.attempts >= 2 && incident.status !== "closed" && (
            <p className="notice warning">
              已用完两次重启，需要你处理；Agent 仍可继续诊断。
            </p>
          )}
          {!incidentResource?.restartAllowed && (
            <p className="muted">该资源没有预授权重启动作。</p>
          )}
          <dl className="key-values">
            <div>
              <dt>事件</dt>
              <dd>{incident.id}</dd>
            </div>
            <div>
              <dt>版本 / 环境</dt>
              <dd>
                {incident.version} / {incident.environmentId}
              </dd>
            </div>
            <div>
              <dt>开始 / 更新</dt>
              <dd>
                {timestamp(incident.openedAt)} / {timestamp(incident.updatedAt)}
              </dd>
            </div>
          </dl>
          {incident.diagnosisId && (
            <section className="section-card diagnosis-summary">
              <div className="section-heading">
                <h3>Agent 诊断</h3>
                <Badge
                  state={incident.diagnosisStatus ?? "unknown"}
                  text={
                    incident.diagnosisStatus === "running"
                      ? "诊断中"
                      : incident.diagnosisStatus === "completed"
                        ? "诊断完成"
                        : incident.diagnosisStatus === "interrupted"
                          ? "诊断中断"
                          : "等待诊断状态"
                  }
                />
              </div>
              <p className="diagnosis-text">
                {incident.diagnosisSummary ||
                  "正在分析最新观测和插件声明的只读能力。"}
              </p>
              <p className="muted">
                诊断建议用于指导下一步，恢复结论由独立验证给出。
              </p>
              <span className="muted break-word">
                诊断记录：{incident.diagnosisId}
              </span>
            </section>
          )}
          <h3>验证证据</h3>
          {snapshot.evidence
            .filter((evidence) => evidence.incidentId === incident.id)
            .map((evidence) => (
              <EvidenceCard key={evidence.id} evidence={evidence} />
            ))}
          {!snapshot.evidence.some(
            (evidence) => evidence.incidentId === incident.id,
          ) && (
            <Empty title="尚无独立验证结果">
              修复动作与验证结果分别记录，等待新鲜证据。
            </Empty>
          )}
          <h3>事件进展</h3>
          <ol className="activity-list">
            {snapshot.events
              .filter((event) => event.incidentId === incident.id)
              .map((event) => (
                <li key={event.id}>
                  <time>{timestamp(event.at)}</time>
                  <span>{event.message}</span>
                </li>
              ))}
          </ol>
        </Modal>
      )}
      {modal && (
        <Modal
          title={modal === "task" ? "新建目标" : "注册插件"}
          onClose={() => {
            setModal("");
            setError("");
          }}
        >
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {modal === "task" ? (
            <form onSubmit={createTask}>
              <label>
                目标名称
                <input
                  autoFocus
                  value={newTask.title}
                  onChange={(event) =>
                    setNewTask({ ...newTask, title: event.target.value })
                  }
                  required
                  maxLength={200}
                />
              </label>
              <label>
                目标与背景
                <textarea
                  value={newTask.goal}
                  onChange={(event) =>
                    setNewTask({ ...newTask, goal: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                工作目录
                <input
                  value={newTask.cwd}
                  onChange={(event) =>
                    setNewTask({ ...newTask, cwd: event.target.value })
                  }
                  placeholder="/绝对路径/项目目录"
                  required
                />
              </label>
              <label>
                模型
                <select
                  value={newTask.model}
                  onChange={(event) =>
                    setNewTask({ ...newTask, model: event.target.value })
                  }
                >
                  {!models.some((model) => model.id === "kimi-k3") && (
                    <option value="kimi-k3">kimi-k3</option>
                  )}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">创建后制定计划，确认标准后开始实际执行。</p>
              <button className="primary" disabled={pending}>
                {pending ? "正在创建…" : "创建目标"}
              </button>
            </form>
          ) : (
            <form onSubmit={registerPlugin}>
              <label>
                Manifest 地址
                <input
                  autoFocus
                  type="url"
                  value={manifestUrl}
                  onChange={(event) => setManifestUrl(event.target.value)}
                  placeholder="http://127.0.0.1:18804/manifest"
                  required
                />
              </label>
              <label>
                凭据环境变量名（可选）
                <input
                  value={credentialEnv}
                  onChange={(event) => setCredentialEnv(event.target.value)}
                  placeholder="REFBOX_PLUGIN_TOKEN"
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                />
              </label>
              <p className="muted">
                填写本地独立服务的能力清单地址。凭据从服务端环境变量读取。
              </p>
              <button className="primary" disabled={pending}>
                {pending ? "正在注册…" : "注册并读取能力"}
              </button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
