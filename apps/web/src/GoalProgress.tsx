import { timestamp } from "./api";
import { Badge, Empty } from "./components";
import type { GoalCheck, GoalLoop } from "./types";

export const goalPhases = {
  planning: "形成执行方案",
  contract_review: "独立审查验收标准",
  executing: "持续推进",
  verifying: "独立验证成果",
  completed: "目标已验证",
  blocked: "需要处理",
  paused: "已暂停",
};
const phaseDescription = {
  planning: "正在理解目标、读取上下文并制定方案。",
  contract_review: "独立验证者检查验收方案是否覆盖你的原始目标。",
  executing: "Agent 正在实际工作；验证发现的缺陷会反馈到下一轮。",
  verifying: "执行已提交成果，独立验证者正在检查实际内容和遗漏。",
  completed: "成果已通过绑定目标、验收标准和当前版本的独立验证。",
  blocked: "自动推进暂时受阻，原因和已取得的证据保留在这里。",
  paused: "你已暂停推进；恢复后沿用已固定的验收标准和记录。",
};
function checkDescription(check: GoalCheck) {
  switch (check.kind) {
    case "file_exists":
      return `文件存在：${check.path}`;
    case "file_contains":
      return `文件内容：${check.path} 包含 ${check.contains}`;
    case "json_equals":
      return `结构化数据：${check.path} · ${check.jsonPath} = ${JSON.stringify(check.equals)}`;
    case "command":
      return {
        tests: "运行项目测试",
        build: "构建项目",
        ui: "验证真实界面",
        diff: "检查代码改动格式",
      }[check.command ?? "tests"];
  }
}

export default function GoalProgress({ loop }: { loop: GoalLoop }) {
  const latest = loop.reviews?.at(-1);
  return (
    <div className="goal-progress">
      <section className="section-card goal-phase" aria-label="目标进展">
        <div className="section-heading" aria-live="polite">
          <h3>{goalPhases[loop.phase]}</h3>
          <span className="count">
            已推进 {loop.rounds} / {loop.maxRounds} 轮
          </span>
        </div>
        <p>{loop.reason || phaseDescription[loop.phase]}</p>
        {latest && latest.verdict !== "pass" && (
          <div className="goal-feedback">
            <Badge state={latest.verdict} />
            <p>{latest.summary}</p>
            {latest.verdict === "fail" && loop.phase === "executing" && (
              <p className="muted">
                正在依据这份独立反馈继续改进，验收标准保持一致。
              </p>
            )}
            {latest.verdict === "inconclusive" && (
              <p className="muted">证据不足会保持待验证，不会标记完成。</p>
            )}
          </div>
        )}
      </section>
      <section className="section-card goal-contract" aria-label="共享验收方案">
        <h3>共享验收方案</h3>
        {loop.contract ? (
          <>
            <p className="goal-criteria">{loop.contract.criteria}</p>
            <ul className="goal-check-list">
              {loop.contract.checks.map((check) => (
                <li key={check.id}>{checkDescription(check)}</li>
              ))}
            </ul>
            <p className="muted">{loop.contract.summary}</p>
            <details>
              <summary>查看独立审查与标准溯源</summary>
              <dl className="key-values">
                <div>
                  <dt>审查记录</dt>
                  <dd>{loop.contract.reviewConversationId}</dd>
                </div>
                <div>
                  <dt>通过时间</dt>
                  <dd>{timestamp(loop.contract.reviewedAt)}</dd>
                </div>
                <div>
                  <dt>固定标准指纹</dt>
                  <dd className="break-word">{loop.contract.hash}</dd>
                </div>
              </dl>
              <p className="muted">
                执行者和验证者共用这份已独立审查的标准。执行者不能自行改写完成条件。
              </p>
              <pre>{loop.contract.definitionJson}</pre>
            </details>
          </>
        ) : (
          <p className="muted">
            正在形成覆盖原始目标的验收方案，独立审查通过后自动开始工作。
          </p>
        )}
      </section>
    </div>
  );
}

export function GoalReviews({ loop }: { loop: GoalLoop }) {
  return (
    <section aria-label="每轮独立证明" className="goal-reviews">
      <h3>每轮独立证明</h3>
      {loop.reviews?.length ? (
        [...loop.reviews].reverse().map((review, reverseIndex) => (
          <article
            className="section-card"
            key={`${review.reviewConversationId}:${review.at}:${reverseIndex}`}
          >
            <div className="section-heading">
              <h4>独立审查 {loop.reviews.length - reverseIndex}</h4>
              <Badge state={review.verdict} />
            </div>
            <p>{review.summary}</p>
            <time className="muted">{timestamp(review.at)}</time>
            <details>
              <summary>查看实际检查与证明</summary>
              <dl className="key-values">
                <div>
                  <dt>独立审查记录</dt>
                  <dd>{review.reviewConversationId}</dd>
                </div>
                <div>
                  <dt>验收标准指纹</dt>
                  <dd className="break-word">
                    {review.contractHash || "标准审查阶段"}
                  </dd>
                </div>
                <div>
                  <dt>成果版本</dt>
                  <dd className="break-word">
                    {review.candidateId || "尚未提交成果版本"}
                  </dd>
                </div>
              </dl>
              {review.checks?.map((value, index) => {
                const check =
                  value && typeof value === "object"
                    ? (value as Record<string, unknown>)
                    : null;
                return (
                  <div className="proof-check" key={index}>
                    <strong>{String(check?.id ?? `检查 ${index + 1}`)}</strong>
                    {typeof check?.passed === "boolean" && (
                      <Badge
                        state={check.passed ? "pass" : "fail"}
                        text={check.passed ? "检查通过" : "检查未通过"}
                      />
                    )}
                    {check?.detail != null && <p>{String(check.detail)}</p>}
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  </div>
                );
              })}
              {review.evidence !== undefined && (
                <pre>{JSON.stringify(review.evidence, null, 2)}</pre>
              )}
            </details>
          </article>
        ))
      ) : (
        <Empty title="等待首次独立验证">
          实际成果提交后，验证证据和改进反馈会持续记录。
        </Empty>
      )}
    </section>
  );
}
