/**
 * 统一提交结果投影（F-02/F-15 基础）。
 *
 * 所有读路径（REST 详情/列表、SSE、队列、客观题）强制复用本函数，
 * 确保竞赛中的判据/隐藏用例不会经任何渠道泄露。
 */

/** 投影上下文：viewer 身份 + 竞赛窗口/成员状态。 */
export type ProjectionCtx = {
  /** 查看者 ID（匿名 null） */
  viewerId: string | null;
  /** 是否管理员（full access） */
  isAdmin: boolean;
  /** 是否提交者本人或题目 owner（full access） */
  isOwner: boolean;
  /** 竞赛上下文；无竞赛为 null */
  contest?: {
    /** 是否竞赛进行中 */
    running: boolean;
    /** 查看者是否为参赛者 */
    participant: boolean;
  } | null;
};

/**
 * 深拷贝并剥离竞赛视角下不可见字段。
 *
 * - admin / 提交者本人或题目 owner / 无竞赛上下文 → 原样返回；
 * - 竞赛进行中 + 参赛者本人 → 保留 status/score，剥离 details 中的
 *   hidden 用例与 subtasks/testCases（旧脚本无 hidden 标记时 fail-safe 全剥）；
 * - 竞赛赛后 + 参赛者本人 → 保留 status/score，hidden 用例仍不返回；
 * - 竞赛中他人 → 仅返回 { id, problem_id, status } 存在级信息。
 */
export function applySubmissionProjection<
  T extends Record<string, unknown>,
>(
  submission: T,
  ctx: ProjectionCtx,
): T {
  // 管理员永远全量。
  if (ctx.isAdmin) {
    return structuredClone(submission);
  }

  // 无竞赛上下文：维持公开提交现状（提交者本人/owner 全量）。
  if (!ctx.contest) {
    return structuredClone(submission);
  }

  const { running, participant } = ctx.contest;
  const isSubmitter = ctx.viewerId !== null &&
    submission.user_id === ctx.viewerId;

  // 题目 owner（非提交者本人）在竞赛内仍全量；提交者本人在赛中/赛后走投影。
  if (ctx.isOwner && !isSubmitter) {
    return structuredClone(submission);
  }

  // 非本人/非参赛者：竞赛内只给存在级信息。
  if (!participant || !isSubmitter) {
    return {
      id: submission.id,
      problem_id: submission.problem_id,
      status: submission.status,
    } as unknown as T;
  }

  const result = structuredClone(submission);
  const record = result as Record<string, unknown>;
  delete record.subtasks;
  delete record.testCases;
  delete record.output;

  // details：保留 visible 用例，hidden 用例及无标记旧数据全部剥离。
  if (record.details !== undefined) {
    const sanitized = sanitizeContestDetails(record.details);
    if (sanitized === undefined) {
      delete record.details;
    } else {
      record.details = sanitized;
    }
  }

  // running/ended 均保留 status/score；赛后不再额外恢复已删除字段。
  void running;
  return result;
}

/**
 * 竞赛视角下的 details 白名单裁剪：
 * - 仅保留带 hidden 标记的用例数据；
 * - 任何用例缺少 hidden 标记 → 视为旧脚本，fail-safe 整体剥离；
 * - 保留非 cases 的安全元数据。
 */
function sanitizeContestDetails(details: unknown): unknown {
  if (typeof details !== "object" || details === null) return undefined;
  const obj = details as Record<string, unknown>;
  if (!Array.isArray(obj.cases)) return undefined;
  const cases = obj.cases;
  if (cases.length === 0) return undefined;

  const allMarked = cases.every(
    (c) => typeof c === "object" && c !== null && "hidden" in c,
  );
  if (!allMarked) return undefined;

  const visibleCases = cases.filter(
    (c) => (c as Record<string, unknown>).hidden !== true,
  );
  return { ...obj, cases: visibleCases };
}
