import { useEffect, useState, type FormEvent } from "react";

type Plan = { steps: string; criteria: string; verificationCommand: string };
type Task = {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  model: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  plan: Plan | null;
  approvedPlan: Plan | null;
  reason: string;
  verified: boolean;
  experiments: {
    id: string;
    at: string;
    hypothesis: string;
    conclusion: string;
    artifacts: string[];
    evidenceEntries: string[];
  }[];
  verifications: {
    at: string;
    command: string;
    exitCode: number;
    output: string;
    summary: string;
  }[];
  reports: { date: string; at: string; markdown: string }[];
};
type Service = {
  id: string;
  name: string;
  url: string;
  description: string;
  operations: string;
};
type View = {
  entries: {
    id: string;
    kind: string;
    model?: {
      role: string;
      content:
        | string
        | { type: string; text?: string; name?: string; arguments?: unknown }[];
    }[];
  }[];
  docs: Record<string, unknown>;
};
const labels: Record<string, string> = {
  draft: "待规划",
  planning: "规划中",
  awaiting_confirmation: "待确认",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  blocked: "有阻塞",
  completed: "已完成",
};
const columns = [
  {
    name: "待安排",
    subtitle: "明确目标，确认计划",
    states: ["draft", "planning", "awaiting_confirmation"],
  },
  {
    name: "进行中",
    subtitle: "持续实验与验证",
    states: ["running", "stopping"],
  },
  {
    name: "待处理",
    subtitle: "需要指引或继续",
    states: ["blocked", "stopped"],
  },
  { name: "已完成", subtitle: "保存经过验证的成果", states: ["completed"] },
];
const time = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

async function api<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers:
      payload === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Refbox-Request": "1",
            "Idempotency-Key": crypto.randomUUID(),
          },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "请求失败");
  return data;
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      refbox<span className="brand-dot">.</span>
    </span>
  );
}
function Tag({ state }: { state: string }) {
  return (
    <span className={"tag " + state}>
      <i />
      {labels[state] ?? state}
    </span>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [password, setPassword] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]),
    [services, setServices] = useState<Service[]>([]),
    [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState(""),
    [view, setView] = useState<View | null>(null),
    [tab, setTab] = useState("tasks"),
    [detailTab, setDetailTab] = useState("overview");
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [modal, setModal] = useState(""),
    [editingService, setEditingService] = useState<Service | null>(null),
    [artifact, setArtifact] = useState<{ path: string; text: string } | null>(
      null,
    );
  const [draft, setDraft] = useState<Plan>({
      steps: "",
      criteria: "",
      verificationCommand: "",
    }),
    [guidance, setGuidance] = useState("");
  const task = tasks.find((t) => t.id === selected);
  useEffect(() => {
    api<{ authenticated: boolean }>("/session")
      .then((x) => setAuthenticated(x.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    api<typeof models>("/models")
      .then(setModels)
      .catch((e) => setError(e.message));
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    setConnected(false);
    setView(null);
    const stream = new EventSource(
      "/api/events" + (selected ? "?task=" + encodeURIComponent(selected) : ""),
    );
    stream.addEventListener("snapshot", (event) => {
      const state = JSON.parse((event as MessageEvent).data);
      setTasks(state.tasks);
      setServices(state.services);
      setView(state.view);
      setConnected(true);
    });
    stream.onerror = () => {
      setConnected(false);
      void api<{ authenticated: boolean }>("/session")
        .then((x) => {
          if (!x.authenticated) setAuthenticated(false);
        })
        .catch(() => {});
    };
    return () => stream.close();
  }, [authenticated, selected]);
  const displayedPlan =
    task?.status === "awaiting_confirmation" || task?.status === "planning"
      ? task?.plan
      : (task?.approvedPlan ?? task?.plan);
  const planKey = displayedPlan ? JSON.stringify(displayedPlan) : "";
  useEffect(() => {
    setDraft(
      displayedPlan ?? { steps: "", criteria: "", verificationCommand: "" },
    );
  }, [selected, planKey]);
  async function perform(fn: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  async function action(name: string, payload: unknown = {}) {
    if (!task) return false;
    return perform(() => api("/tasks/" + task.id + "/" + name, payload));
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      await api("/login", { password });
      setAuthenticated(true);
      setPassword("");
    });
  }
  async function createTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await perform(async () => {
      const t = await api<Task>("/tasks", Object.fromEntries(form));
      setTasks((prev) => [...prev.filter((x) => x.id !== t.id), t]);
      setSelected(t.id);
      setModal("");
      setDetailTab("overview");
    });
  }
  async function saveService(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await perform(async () => {
      await api("/services", {
        ...Object.fromEntries(form),
        ...(editingService ? { id: editingService.id } : {}),
      });
      setModal("");
      setEditingService(null);
    });
  }
  async function showArtifact(path: string) {
    await perform(async () => {
      const res = await fetch(
        "/api/tasks/" + task!.id + "/artifact?path=" + encodeURIComponent(path),
      );
      if (!res.ok) throw new Error("产物无法读取");
      setArtifact({ path, text: await res.text() });
    });
  }

  if (authenticated === null)
    return (
      <main className="loading">
        <Brand />
        <p>正在连接你的 Agent 工作空间…</p>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login">
        <section className="login-intro">
          <Brand />
          <span className="eyebrow">YOUR AGENTS, AT HOME</span>
          <h1>
            让想法持续推进。
            <br />
            <em>让成果留下证据。</em>
          </h1>
          <p>
            你的 Homelab 控制层。安排目标，让 Agent
            继续工作，明天回来查看它完成了什么。
          </p>
          <div className="login-foot">
            <span>Pi Durable</span>
            <span>自指引擎 · v0.1</span>
          </div>
        </section>
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow">WELCOME HOME</span>
          <h2>进入工作空间</h2>
          <p>使用你的管理员密码登录。</p>
          <label>
            管理员密码
            <input
              autoFocus
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={pending}>
            {pending ? "正在登录…" : "进入 refbox →"}
          </button>
          <small>个人工作空间 · 家庭网络与私人 VPN</small>
        </form>
      </main>
    );

  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <div className="space-label">PERSONAL HOMELAB</div>
        <nav>
          <button
            className={tab === "tasks" ? "active" : ""}
            onClick={() => setTab("tasks")}
          >
            <span>▦</span>任务看板 <b>{tasks.length}</b>
          </button>
          <button
            className={tab === "services" ? "active" : ""}
            onClick={() => setTab("services")}
          >
            <span>◈</span>服务入口 <b>{services.length}</b>
          </button>
          <button
            className={tab === "about" ? "active" : ""}
            onClick={() => setTab("about")}
          >
            <span>◎</span>工作方式
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-state">
            <i className={connected ? "online" : ""} />
            <div>
              <strong>{connected ? "工作空间已连接" : "正在重新连接"}</strong>
              <small>Pi Durable · Engy</small>
            </div>
          </div>
          <button
            onClick={() =>
              perform(async () => {
                await api("/logout", {});
                setAuthenticated(false);
              })
            }
          >
            退出登录 ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div className="breadcrumb">
            工作空间 <span>/</span>{" "}
            {tab === "tasks"
              ? "任务看板"
              : tab === "services"
                ? "服务入口"
                : "工作方式"}
          </div>
          <div className="header-right">
            <span className="avatar">R</span>
            <span>个人 Homelab</span>
            <button
              className="mobile-logout"
              onClick={() =>
                perform(async () => {
                  await api("/logout", {});
                  setAuthenticated(false);
                })
              }
            >
              退出
            </button>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <span className="eyebrow">
              {tab === "tasks"
                ? "CONTINUOUS WORK"
                : tab === "services"
                  ? "CONNECTED SERVICES"
                  : "HOW REFBOX WORKS"}
            </span>
            <h1>
              {tab === "tasks"
                ? "让目标持续向前。"
                : tab === "services"
                  ? "每个服务，各司其职。"
                  : "一个有验证闭环的家。"}
            </h1>
            <p>
              {tab === "tasks"
                ? "安排、观察、指引。成果与经验会留在这里。"
                : tab === "services"
                  ? "业务保持独立，Agent 连接并操作它们。"
                  : "明确目标，确认标准，再让 Agent 自主推进。"}
            </p>
          </div>
          {tab !== "about" && (
            <button
              className="primary"
              onClick={() => {
                setEditingService(null);
                setModal(tab === "tasks" ? "task" : "service");
              }}
            >
              ＋ {tab === "tasks" ? "新建目标" : "添加服务"}
            </button>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {tab === "tasks" && (
          <>
            <div className="stats">
              <div>
                <span>正在推进</span>
                <strong>
                  {tasks.filter((t) => t.status === "running").length}
                  <small>个目标</small>
                </strong>
              </div>
              <div>
                <span>需要你的决定</span>
                <strong>
                  {
                    tasks.filter((t) =>
                      ["blocked", "awaiting_confirmation"].includes(t.status),
                    ).length
                  }
                  <small>项待处理</small>
                </strong>
              </div>
              <div>
                <span>已验证的成果</span>
                <strong>
                  {tasks.filter((t) => t.verified).length}
                  <small>项已完成</small>
                </strong>
              </div>
              <div className="stats-note">
                <span className="sun">◌</span>
                <div>
                  <b>明天见，也随时见。</b>
                  <p>每天 09:00 保存进展汇报</p>
                </div>
              </div>
            </div>
            <div className="board">
              {columns.map((col, index) => (
                <section className="column" key={col.name}>
                  <div className="column-head">
                    <span className={"column-dot dot-" + index} />
                    <h2>{col.name}</h2>
                    <b>
                      {
                        tasks.filter((t) => col.states.includes(t.status))
                          .length
                      }
                    </b>
                  </div>
                  <p className="column-subtitle">{col.subtitle}</p>
                  {tasks
                    .filter((t) => col.states.includes(t.status))
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((t) => (
                      <button
                        className="task-card"
                        key={t.id}
                        onClick={() => {
                          setSelected(t.id);
                          setDetailTab("overview");
                        }}
                      >
                        <Tag state={t.status} />
                        <h3>{t.title}</h3>
                        <p>{t.goal}</p>
                        <div className="card-meta">
                          <span>{t.model}</span>
                          <span>{t.experiments.length} 次实验</span>
                        </div>
                        <footer>
                          <span className="mini-avatar">π</span>
                          <span>{time(t.updatedAt)}</span>
                          <span className="card-arrow">↗</span>
                        </footer>
                      </button>
                    ))}
                  {!tasks.some((t) => col.states.includes(t.status)) && (
                    <div className="column-empty">
                      <span>＋</span>
                      {index === 0
                        ? "从一个清晰的目标开始"
                        : "等待目标进入这里"}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
        {tab === "services" && (
          <div className="services">
            {services.map((s) => (
              <article className="service-card" key={s.id}>
                <span className="service-icon">◈</span>
                <h2>{s.name}</h2>
                <p>{s.description || "独立运行的 Homelab 服务"}</p>
                <small>{s.url}</small>
                <pre>{s.operations || "尚未添加运维说明。"}</pre>
                <div>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    打开服务 ↗
                  </a>
                  <button
                    onClick={() => {
                      setEditingService(s);
                      setModal("service");
                    }}
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => {
                      setTab("tasks");
                      setModal("task");
                    }}
                  >
                    新建运维目标
                  </button>
                </div>
              </article>
            ))}
            {!services.length && (
              <div className="empty-state">
                <span>◈</span>
                <h2>为你的服务留一个入口</h2>
                <p>
                  添加财务管理、模型实验室或其他应用。
                  <br />
                  需要操作它时，交给 Agent 一个明确的目标。
                </p>
                <button className="primary" onClick={() => setModal("service")}>
                  添加第一个服务
                </button>
              </div>
            )}
          </div>
        )}
        {tab === "about" && (
          <div className="about">
            <h2>提出假设，行动，再验证。</h2>
            <div className="flow">
              {["给定目标", "确认计划", "自主实验", "验证成果", "保留经验"].map(
                (x, i) => (
                  <div key={x}>
                    <small>0{i + 1}</small>
                    <strong>{x}</strong>
                  </div>
                ),
              )}
            </div>
            <p>
              refbox 是你的 Homelab 看板和控制层。Pi Durable
              负责长期执行与恢复，独立业务保持自己的服务与数据。
            </p>
            <p>
              规划阶段不会执行运维命令。确认后 Agent
              在约定目标下自主工作，验证成功后停止。你可以随时补充指引、停止或继续。
            </p>
            <p>
              Agent 可以开发 refbox 的改进；正在运行的版本由你决定何时更新。
            </p>
            <a
              href="https://github.com/WASIDJ/refbox"
              target="_blank"
              rel="noreferrer"
            >
              查看项目与需求讨论 ↗
            </a>
          </div>
        )}
        <footer className="page-footer">
          REFBOX <span>持续尝试，有据可循。</span>
          <span>个人工作空间</span>
        </footer>
      </main>

      {task && (
        <div className="drawer-backdrop" onClick={() => setSelected("")}>
          <section className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <span className="eyebrow">GOAL / {task.id.slice(-6)}</span>
              <button aria-label="关闭任务详情" onClick={() => setSelected("")}>
                ×
              </button>
            </div>
            <Tag state={task.status} />
            <h1>{task.title}</h1>
            <p className="goal-text">{task.goal}</p>
            <div className="task-info">
              <span>{task.model}</span>
              <span>{task.cwd}</span>
            </div>
            <div className="detail-nav">
              {[
                ["overview", "目标与控制"],
                ["logs", "运行过程"],
                ["results", "实验与成果"],
                ["reports", "汇报"],
              ].map(([id, name]) => (
                <button
                  className={detailTab === id ? "active" : ""}
                  key={id}
                  onClick={() => setDetailTab(id)}
                >
                  {name}
                </button>
              ))}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {detailTab === "overview" && (
              <div className="detail-content">
                {task.reason && <div className="notice">{task.reason}</div>}
                {task.status === "draft" && (
                  <div className="notice">
                    <h3>先明确执行标准</h3>
                    <p>Agent 会提出计划与验证命令。确认前不会操作你的机器。</p>
                    <button
                      className="primary"
                      disabled={pending}
                      onClick={() => action("plan")}
                    >
                      让 Agent 制定计划 →
                    </button>
                  </div>
                )}
                {task.status === "planning" && (
                  <div className="notice">
                    正在制定计划，进入“运行过程”查看进展。
                  </div>
                )}
                {task.plan && (
                  <div className="plan-form">
                    <h3>
                      {task.status === "awaiting_confirmation"
                        ? "确认执行计划"
                        : "执行标准"}
                    </h3>
                    <label>
                      执行步骤
                      <textarea
                        value={draft.steps}
                        onChange={(e) =>
                          setDraft({ ...draft, steps: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      完成标准
                      <textarea
                        value={draft.criteria}
                        onChange={(e) =>
                          setDraft({ ...draft, criteria: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      验证命令
                      <textarea
                        className="code"
                        value={draft.verificationCommand}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            verificationCommand: e.target.value,
                          })
                        }
                      />
                    </label>
                    <small>
                      宿主执行该命令，退出码 0
                      表示达到标准。请确认命令实际检验了目标。
                    </small>
                    {["awaiting_confirmation", "blocked", "stopped"].includes(
                      task.status,
                    ) && (
                      <button
                        className="primary"
                        disabled={pending}
                        onClick={() => action("approve", draft)}
                      >
                        确认标准并开始执行 →
                      </button>
                    )}
                  </div>
                )}
                {["running", "planning", "stopping"].includes(task.status) && (
                  <button
                    className="danger"
                    disabled={pending || task.status === "stopping"}
                    onClick={() => action("stop")}
                  >
                    {task.status === "stopping" ? "正在停止…" : "停止当前执行"}
                  </button>
                )}
                {["stopped", "blocked"].includes(task.status) && (
                  <div className="actions">
                    {task.approvedPlan && (
                      <button
                        className="primary"
                        disabled={pending}
                        onClick={() => action("continue")}
                      >
                        继续已批准的任务
                      </button>
                    )}
                    <button disabled={pending} onClick={() => action("plan")}>
                      重新制定计划
                    </button>
                  </div>
                )}
                {task.status === "running" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action("steer", { message: guidance }).then((ok) => {
                        if (ok) setGuidance("");
                      });
                    }}
                  >
                    <label>
                      补充指引
                      <textarea
                        placeholder="告诉 Agent 新发现，或调整下一步的重点…"
                        value={guidance}
                        onChange={(e) => setGuidance(e.target.value)}
                        required
                      />
                    </label>
                    <button disabled={pending}>发送指引 ↗</button>
                  </form>
                )}
              </div>
            )}
            {detailTab === "logs" && (
              <div className="detail-content logs">
                {(view?.entries ?? []).flatMap((e) =>
                  (e.model ?? []).map((m, i) => (
                    <article
                      key={e.id + ":" + i}
                      className={"log-entry " + m.role}
                    >
                      <small>
                        {m.role === "user"
                          ? "指令"
                          : m.role === "assistant"
                            ? "Agent"
                            : m.role === "toolResult"
                              ? "工具结果"
                              : "系统配置"}{" "}
                        · {String(e.id).slice(-6)}
                      </small>
                      {m.role === "system" ? (
                        <p>执行配置已保存。</p>
                      ) : typeof m.content === "string" ? (
                        <pre>{m.content}</pre>
                      ) : (
                        m.content
                          .filter((x) => x.type !== "thinking")
                          .map((block, j) => (
                            <pre key={j}>
                              {block.text ??
                                (block.type === "toolCall"
                                  ? `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`
                                  : "")}
                            </pre>
                          ))
                      )}
                    </article>
                  )),
                )}
                {view && Object.keys(view.docs).length > 0 && (
                  <details>
                    <summary>原生执行状态与用量</summary>
                    <pre>{JSON.stringify(view.docs, null, 2)}</pre>
                  </details>
                )}
                {!view?.entries.length && (
                  <p className="muted">尚无运行记录。</p>
                )}
              </div>
            )}
            {detailTab === "results" && (
              <div className="detail-content">
                <h3>
                  实验记录{" "}
                  <span className="count">{task.experiments.length}</span>
                </h3>
                {task.experiments.map((e) => (
                  <article className="result-card" key={e.id}>
                    <small>{time(e.at)}</small>
                    <h4>{e.hypothesis}</h4>
                    <p>{e.conclusion}</p>
                    <small>
                      {e.evidenceEntries.length} 条关联工具证据 · 结论由 Agent
                      记录
                    </small>
                    {e.artifacts.map((p) => (
                      <button
                        className="artifact"
                        key={p}
                        onClick={() => showArtifact(p)}
                      >
                        ↗ {p}
                      </button>
                    ))}
                  </article>
                ))}
                {!task.experiments.length && (
                  <p className="muted">尚无实验记录。</p>
                )}
                <h3>实际验证</h3>
                {task.verifications.map((v, i) => (
                  <article className="result-card" key={i}>
                    <b className={v.exitCode === 0 ? "success" : "failure"}>
                      退出码 {v.exitCode}
                    </b>
                    <p>{v.summary}</p>
                    <pre>{v.command}</pre>
                    <details>
                      <summary>查看验证输出</summary>
                      <pre>{v.output || "（无输出）"}</pre>
                    </details>
                  </article>
                ))}
                {!task.verifications.length && (
                  <p className="muted">尚未执行验证。</p>
                )}
              </div>
            )}
            {detailTab === "reports" && (
              <div className="detail-content">
                <div className="report-heading">
                  <h3>进展汇报</h3>
                  <button disabled={pending} onClick={() => action("report")}>
                    保存今日汇报
                  </button>
                </div>
                <p className="muted">
                  每天 09:00 自动保存。当天已有汇报不会重复生成。
                </p>
                {[...task.reports].reverse().map((r) => (
                  <article className="report-card" key={r.date}>
                    <small>{time(r.at)}</small>
                    <pre>{r.markdown}</pre>
                  </article>
                ))}
                {!task.reports.length && (
                  <div className="notice">
                    汇报会保存在这里，关联实验、验证结果和后续计划。
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal("")}>
          <section className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <span className="eyebrow">
                {modal === "task" ? "NEW GOAL" : "SERVICE DIRECTORY"}
              </span>
              <button aria-label="关闭新建窗口" onClick={() => setModal("")}>
                ×
              </button>
            </div>
            <h2>{modal === "task" ? "交给 Agent 一个目标" : "添加独立服务"}</h2>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {modal === "task" ? (
              <form onSubmit={createTask}>
                <label>
                  目标名称
                  <input
                    name="title"
                    autoFocus
                    placeholder="例如：为财务服务生成月度报告"
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  目标与背景
                  <textarea
                    name="goal"
                    placeholder="希望完成什么？有哪些已知条件或约束？"
                    required
                  />
                </label>
                <label>
                  工作目录
                  <input name="cwd" placeholder="/绝对路径/项目目录" required />
                </label>
                <label>
                  模型
                  <select
                    name="model"
                    defaultValue={
                      models.some((m) => m.id === "kimi-k3")
                        ? "kimi-k3"
                        : models[0]?.id
                    }
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">
                  创建后先制定计划，确认标准后才开始实际执行。
                </p>
                <button className="primary" disabled={pending}>
                  创建目标 →
                </button>
              </form>
            ) : (
              <form onSubmit={saveService}>
                <label>
                  服务名称
                  <input
                    name="name"
                    autoFocus
                    defaultValue={editingService?.name}
                    required
                  />
                </label>
                <label>
                  访问地址
                  <input
                    name="url"
                    type="url"
                    placeholder="http://服务地址"
                    defaultValue={editingService?.url}
                    required
                  />
                </label>
                <label>
                  简介
                  <textarea
                    name="description"
                    defaultValue={editingService?.description}
                  />
                </label>
                <label>
                  运维说明
                  <textarea
                    name="operations"
                    placeholder="所在机器、启动方式、API 或相关文档…请勿填写密钥。"
                    defaultValue={editingService?.operations}
                  />
                </label>
                <button className="primary" disabled={pending}>
                  保存服务
                </button>
              </form>
            )}
          </section>
        </div>
      )}
      {artifact && (
        <div className="modal-backdrop" onClick={() => setArtifact(null)}>
          <section
            className="modal artifact-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <strong>{artifact.path}</strong>
              <button aria-label="关闭产物" onClick={() => setArtifact(null)}>
                ×
              </button>
            </div>
            <small>文本预览，最多读取 1 MiB。</small>
            <pre>{artifact.text}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
