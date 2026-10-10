import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Icon({
  name,
}: {
  name: "home" | "tasks" | "plugins" | "arrow" | "close" | "plus" | "refresh";
}) {
  const paths = {
    home: "M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8",
    tasks: "M4 4h16v16H4zM9 4v16M15 4v16",
    plugins: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    arrow: "M5 12h14M13 6l6 6-6 6",
    close: "m6 6 12 12M6 18 18 6",
    plus: "M12 5v14M5 12h14",
    refresh:
      "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M18 17a7 7 0 0 1-12 1l-2-3",
  };
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const labels: Record<string, string> = {
  healthy: "健康",
  unhealthy: "异常",
  unknown: "未知",
  stale: "样本过期",
  diagnosing: "诊断中",
  acting: "修复中",
  proving: "验证中",
  attention: "需要处理",
  closed: "已恢复",
  pending: "待验证",
  pass: "验证通过",
  fail: "验证失败",
  inconclusive: "证据不足",
  manual: "人工判断",
  backlog: "待安排",
  active: "进行中",
  done: "已完成",
  draft: "待规划",
  planning: "规划中",
  awaiting_confirmation: "待确认计划",
  running: "执行中",
  stopping: "停止中",
  stopped: "已停止",
  blocked: "执行阻塞",
  completed: "执行结束",
  online: "在线",
  offline: "离线",
  available: "可用",
  idle: "待命",
  unavailable: "不可用",
  legacy: "历史检查",
  unverified: "未独立验证",
};
export function Badge({ state, text }: { state: string; text?: string }) {
  return (
    <span className={`badge state-${state}`}>
      <span aria-hidden="true" className="status-dot" />
      {text ?? labels[state] ?? state}
    </span>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function StatusTriple({
  business,
  execution,
  proof,
}: {
  business: string;
  execution: string;
  proof: string;
}) {
  return (
    <dl className="state-triple">
      <div>
        <dt>任务</dt>
        <dd>
          <Badge state={business} />
        </dd>
      </div>
      <div>
        <dt>执行</dt>
        <dd>
          <Badge state={execution} />
        </dd>
      </div>
      <div>
        <dt>验证</dt>
        <dd>
          <Badge
            state={proof}
            text={proof === "manual" ? "人工验收" : undefined}
          />
        </dd>
      </div>
    </dl>
  );
}
