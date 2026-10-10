import { useEffect, useState, type FormEvent } from "react";
import { api, timestamp } from "./api";
import { Badge, Empty, Modal, StatusTriple } from "./components";
import type { LegacyTask, Plan, Task, View } from "./types";

export default function TaskDetail({
  task,
  onClose,
  refresh,
}: {
  task: Task;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState("overview"),
    [legacy, setLegacy] = useState<LegacyTask | null>(null),
    [view, setView] = useState<View | null>(null);
  const [error, setError] = useState(""),
    [viewError, setViewError] = useState(""),
    [pending, setPending] = useState(false),
    [guidance, setGuidance] = useState(""),
    [acceptance, setAcceptance] = useState("");
  const [business, setBusiness] = useState(task.businessStatus),
    [artifact, setArtifact] = useState<{ path: string; text: string } | null>(
      null,
    );
  const [draft, setDraft] = useState<Plan>({
    steps: "",
    criteria: "",
    verificationCommand: "",
  });
  async function load() {
    try {
      const data = await api<{ view: View; task: LegacyTask }>(
        `/platform/tasks/${encodeURIComponent(task.id)}/view`,
      );
      setLegacy(data.task);
      setView(data.view);
      setViewError("");
    } catch (cause) {
      setViewError((cause as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [task.id]);
  useEffect(() => setBusiness(task.businessStatus), [task.businessStatus]);
  const execution = legacy?.status ?? task.executionStatus;
  const plan = ["awaiting_confirmation", "planning"].includes(execution)
    ? legacy?.plan
    : (legacy?.approvedPlan ?? legacy?.plan);
  const planKey = JSON.stringify(plan);
  useEffect(
    () =>
      setDraft(plan ?? { steps: "", criteria: "", verificationCommand: "" }),
    [planKey],
  );
  async function perform(operation: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await operation();
      await refresh();
      await load();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  const action = (name: string, body: unknown = {}) =>
    perform(() =>
      api(`/platform/tasks/${encodeURIComponent(task.id)}/${name}`, body),
    );
  async function showArtifact(path: string) {
    await perform(async () => {
      const response = await fetch(
        `/api/platform/tasks/${encodeURIComponent(task.id)}/artifact?path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw new Error(`产物无法读取（${response.status}）`);
      setArtifact({ path, text: await response.text() });
    });
  }
  async function saveStatus(event: FormEvent) {
    event.preventDefault();
    await action("status", { status: business });
  }
  return (
    <Modal title="任务详情" onClose={onClose} wide>
      <div className="task-detail-title">
        <h3>{task.title}</h3>
        <p>{task.goal}</p>
        <StatusTriple
          business={task.businessStatus}
          execution={execution}
          proof={task.verificationStatus}
        />
      </div>
      {!task.engineAvailable && (
        <p className="notice warning">
          执行服务离线，任务记录仍然保留。恢复后可以继续查看和执行。
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <p className="notice" role="status">
          正在提交请求…
        </p>
      )}
      <nav className="detail-tabs" aria-label="任务详情分页">
        {[
          ["overview", "目标与控制"],
          ["results", "实验与成果"],
          ["logs", "运行过程"],
          ["reports", "汇报"],
        ].map(([id, name]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <div className="detail-content">
          <form className="inline-status" onSubmit={saveStatus}>
            <label>
              任务状态
              <select
                value={business}
                onChange={(event) => setBusiness(event.target.value)}
              >
                {[
                  ["backlog", "待安排"],
                  ["active", "进行中"],
                  ["attention", "需要处理"],
                  ["done", "已完成"],
                ].map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={pending || business === task.businessStatus}
            >
              保存状态
            </button>
          </form>
          <p className="muted">
            标记完成需要独立验证通过或人工验收；执行结束和历史检查保留为单独状态。
          </p>
          {task.verificationStatus === "manual" && (
            <section className="section-card">
              <h3>人工验收记录</h3>
              <p>{task.manualReason || "已由用户确认完成"}</p>
              <span className="muted">{timestamp(task.acceptedAt)}</span>
            </section>
          )}
          {task.verificationStatus !== "pass" && (
            <details className="acceptance-form">
              <summary>人工验收</summary>
              <p className="muted">
                你亲自检查产物和完成标准后可以验收。系统会记为人工验收，保留与独立验证的区别。
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action("accept", { reason: acceptance }).then(
                    (success) => {
                      if (success) setAcceptance("");
                    },
                  );
                }}
              >
                <label>
                  验收依据
                  <textarea
                    value={acceptance}
                    onChange={(event) => setAcceptance(event.target.value)}
                    placeholder="检查了哪些产物和标准？实际结果是什么？"
                    required
                    minLength={3}
                  />
                </label>
                <button disabled={pending || acceptance.trim().length < 3}>
                  确认人工验收
                </button>
              </form>
            </details>
          )}
          <dl className="key-values">
            <div>
              <dt>模型</dt>
              <dd>{task.model}</dd>
            </div>
            <div>
              <dt>工作目录</dt>
              <dd>{task.cwd}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{timestamp(task.createdAt)}</dd>
            </div>
          </dl>
          {legacy?.reason && <p className="notice warning">{legacy.reason}</p>}
          {viewError && (
            <p className="notice warning">执行记录暂不可用：{viewError}</p>
          )}
          {execution === "draft" && (
            <section className="section-card">
              <h3>制定执行计划</h3>
              <p>Agent 提出步骤和成果检查，你确认后开始执行。</p>
              <button
                className="primary"
                disabled={pending || !task.engineAvailable}
                onClick={() => void action("plan")}
              >
                让 Agent 制定计划
              </button>
            </section>
          )}
          {execution === "planning" && (
            <p className="notice">正在制定计划，可在运行过程查看进展。</p>
          )}
          {plan && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action("approve", draft);
              }}
              className="plan-form"
            >
              <h3>
                {execution === "awaiting_confirmation"
                  ? "确认执行计划"
                  : "执行标准"}
              </h3>
              <label>
                执行步骤
                <textarea
                  value={draft.steps}
                  readOnly={
                    !["awaiting_confirmation", "blocked", "stopped"].includes(
                      execution,
                    )
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, steps: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                完成标准
                <textarea
                  value={draft.criteria}
                  readOnly={
                    !["awaiting_confirmation", "blocked", "stopped"].includes(
                      execution,
                    )
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, criteria: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                执行检查命令
                <textarea
                  className="code"
                  value={draft.verificationCommand}
                  readOnly={
                    !["awaiting_confirmation", "blocked", "stopped"].includes(
                      execution,
                    )
                  }
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      verificationCommand: event.target.value,
                    })
                  }
                  required
                />
              </label>
              <p className="muted">
                此命令记录执行侧的检查结果。独立验证由验证服务另行给出。
              </p>
              {["awaiting_confirmation", "blocked", "stopped"].includes(
                execution,
              ) && (
                <button
                  className="primary"
                  disabled={pending || !task.engineAvailable}
                >
                  确认标准并开始执行
                </button>
              )}
            </form>
          )}
          {["running", "planning", "stopping"].includes(execution) && (
            <button
              className="danger"
              disabled={
                pending || execution === "stopping" || !task.engineAvailable
              }
              onClick={() => void action("stop")}
            >
              {execution === "stopping" ? "正在停止…" : "停止当前执行"}
            </button>
          )}
          {["stopped", "blocked"].includes(execution) && (
            <div className="button-row">
              {legacy?.approvedPlan && (
                <button
                  className="primary"
                  disabled={pending || !task.engineAvailable}
                  onClick={() => void action("continue")}
                >
                  继续已批准的任务
                </button>
              )}
              <button
                disabled={pending || !task.engineAvailable}
                onClick={() => void action("plan")}
              >
                重新制定计划
              </button>
            </div>
          )}
          {execution === "running" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action("steer", { message: guidance }).then((success) => {
                  if (success) setGuidance("");
                });
              }}
            >
              <label>
                补充指引
                <textarea
                  value={guidance}
                  onChange={(event) => setGuidance(event.target.value)}
                  placeholder="补充新发现，或调整下一步重点"
                  required
                />
              </label>
              <button disabled={pending || !task.engineAvailable}>
                发送指引
              </button>
            </form>
          )}
        </div>
      )}
      {tab === "results" && (
        <div className="detail-content">
          {viewError && <p className="notice warning">{viewError}</p>}
          <h3>实验记录</h3>
          {(legacy?.experiments ?? []).map((experiment) => (
            <article className="section-card" key={experiment.id}>
              <span className="muted">{timestamp(experiment.at)}</span>
              <h4>{experiment.hypothesis}</h4>
              <p>{experiment.conclusion}</p>
              <p className="muted">
                {experiment.evidenceEntries.length} 条工具证据 · Agent
                记录的结论
              </p>
              {experiment.artifacts.map((path) => (
                <button
                  className="artifact"
                  key={path}
                  onClick={() => void showArtifact(path)}
                >
                  {path}
                </button>
              ))}
            </article>
          ))}
          {!legacy?.experiments.length && <Empty title="尚无实验记录" />}
          <h3>执行侧检查</h3>
          <p className="muted">原始检查完整保留，不作为独立验证的通过结论。</p>
          {(legacy?.verifications ?? []).map((verification, index) => (
            <article className="section-card" key={index}>
              <Badge
                state={verification.exitCode === 0 ? "pass" : "fail"}
                text={`退出码 ${verification.exitCode}`}
              />
              <p>{verification.summary}</p>
              <pre>{verification.command}</pre>
              <details>
                <summary>查看检查输出</summary>
                <pre>{verification.output || "（无输出）"}</pre>
              </details>
            </article>
          ))}
          {!legacy?.verifications.length && <Empty title="尚未执行检查" />}
          {task.legacyVerified && (
            <p className="notice">
              历史执行检查已通过。当前独立验证状态：
              <Badge state={task.verificationStatus} />
            </p>
          )}
        </div>
      )}
      {tab === "logs" && (
        <div className="detail-content">
          {viewError && <p className="notice warning">{viewError}</p>}
          {(view?.entries ?? []).flatMap((entry) =>
            (entry.model ?? []).map((message, index) => (
              <article className="log-entry" key={`${entry.id}:${index}`}>
                <h4>
                  {message.role === "user"
                    ? "指令"
                    : message.role === "assistant"
                      ? "Agent"
                      : message.role === "toolResult"
                        ? "工具结果"
                        : "执行配置"}
                  <span className="muted"> · {String(entry.id).slice(-6)}</span>
                </h4>
                {message.role === "system" ? (
                  <p>执行配置已保存。</p>
                ) : typeof message.content === "string" ? (
                  <pre>{message.content}</pre>
                ) : (
                  message.content
                    .filter((block) => block.type !== "thinking")
                    .map((block, i) => (
                      <pre key={i}>
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
          {!view?.entries.length && <Empty title="尚无运行记录" />}
          {view && Object.keys(view.docs).length > 0 && (
            <details>
              <summary>原生执行状态与用量</summary>
              <pre>{JSON.stringify(view.docs, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {tab === "reports" && (
        <div className="detail-content">
          <div className="section-heading">
            <h3>进展汇报</h3>
            <button
              disabled={pending || !task.engineAvailable}
              onClick={() => void action("report")}
            >
              保存今日汇报
            </button>
          </div>
          <p className="muted">
            每天 09:00 自动保存，当天已有汇报不会重复生成。
          </p>
          {[...(legacy?.reports ?? [])].reverse().map((report) => (
            <article className="section-card" key={report.date}>
              <span className="muted">{timestamp(report.at)}</span>
              <pre>{report.markdown}</pre>
            </article>
          ))}
          {!legacy?.reports.length && <Empty title="尚无汇报" />}
          {viewError && <p className="notice warning">{viewError}</p>}
        </div>
      )}
      {artifact && (
        <Modal title="产物内容" onClose={() => setArtifact(null)} wide>
          <p className="muted artifact-path">{artifact.path}</p>
          <pre>{artifact.text}</pre>
        </Modal>
      )}
    </Modal>
  );
}
