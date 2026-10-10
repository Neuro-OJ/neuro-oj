import { useApi } from './useApi';

/**
 * 题目版本、草稿、发布与批量任务 API 层（Handbook §4.1 / §4.3 / §4.4 / §4.5）。
 *
 * 设计要点：
 * - **三个独立动作**：保存草稿、发布版本、切换有效版本策略互不耦合；重测/升级是
 *   独立的后台任务，不再由"重测按钮"直接改提交状态。
 * - **乐观锁**：草稿写入与发布都必须携带预期 `revision`（缺失/过时由服务端 428/409
 *   拒绝）；本层统一用 `If-Match` 头。
 * - **幂等**：批任务受理必须携带 `Idempotency-Key`，同键同请求复用原任务。
 */

/** 有效版本策略（题库与「竞赛 × 题目」各自独立）。 */
export type EffectiveVersionPolicy =
  | { mode: 'any' }
  | { mode: 'exact'; version_id: string };

/** 已发布版本元数据。 */
export interface ProblemVersionSummary {
  id: string;
  problem_id: string;
  version: number;
  schema_version: number;
  origin: string;
  content_sha256: string | null;
  change_note: string;
  published_by: string | null;
  published_at: string;
  is_latest: boolean;
}

/** 指定版本的完整内容（非编辑者已被服务端裁剪客观题答案）。 */
export interface ProblemVersionDetail {
  version_id: string;
  version: number;
  origin: string;
  change_note: string;
  published_at: string;
  is_latest: boolean;
  content: Record<string, unknown>;
}

/** 共享草稿视图（`synthesized` 表示尚未落库、由服务端派生）。 */
export interface ProblemDraftView {
  problem_id: string;
  base_version_id: string | null;
  revision: number;
  content: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string | null;
  synthesized: boolean;
}

/** 发布预检报告。 */
export interface PublishPreflightReport {
  problem_id: string;
  revision: number;
  base_version_id: string | null;
  content_complete: boolean;
  content_hash: string | null;
  files: Array<{
    role: string;
    path: string;
    state: string;
    exists: boolean | null;
    byte_size: number | null;
    sha256: string | null;
  }>;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings: Array<{ code: string; message: string; path?: string }>;
  ready: boolean;
}

/** 发布结果。 */
export interface PublishVersionResult {
  problem_id: string;
  version_id: string;
  version: number;
  draft_revision: number;
  unchanged: boolean;
}

/** 重测目标。 */
export type RejudgeTarget =
  | { mode: 'submitted' }
  | { mode: 'latest' }
  | { mode: 'specified'; versions: Record<string, string> };

/** 重测范围。 */
export type RejudgeScope =
  | {
    type: 'selected';
    submissions: Array<{ kind: 'submission' | 'objective'; id: string }>;
  }
  | { type: 'problem'; problem_id: string }
  | { type: 'contest'; contest_id: string };

/** 策略变更（受理事务内应用，带预期 revision）。 */
export interface PolicyChange {
  problem_id: string;
  contest_id?: string;
  expected_revision: number;
  policy: EffectiveVersionPolicy;
}

/** 重测请求。 */
export interface RejudgeRequest {
  kind: 'rejudge';
  scope: RejudgeScope;
  target: RejudgeTarget;
  policy_changes?: PolicyChange[];
}

/** 受理结果。 */
export interface AcceptJobResult {
  job_id: string;
  status: string;
  total_items: number;
  existing?: boolean;
}

/** 任务条目视图。 */
export interface SubmissionJobItemView {
  id: string;
  ordinal: number;
  source_kind: string;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  status: string;
  attempt_id: string | null;
  result_submission_id: string | null;
  reason_code: string | null;
  reason_message: string | null;
  dispatch_retries: number;
}

/** 任务视图（含条目状态计数，由持久化条目聚合）。 */
export interface SubmissionJobView {
  id: string;
  kind: string;
  actor_id: string;
  status: string;
  request_hash?: string;
  total_items: number;
  counts: Record<string, number>;
  created_at: string;
  finished_at: string | null;
}

/** 用户升级任务视图（本人或管理员可读）。 */
export interface UpgradeJobView {
  id: string;
  status: string;
  actor_id: string;
  context: 'practice' | 'source_contest';
  items: Array<{
    id: string;
    source_kind: string;
    source_id: string;
    problem_id: string;
    target_version_id: string | null;
    status: string;
    reason_code: string | null;
    result_submission_id: string | null;
  }>;
}

/** 任务是否已到终态。 */
export function isJobTerminal(status: string): boolean {
  return status === 'completed' || status === 'completed_with_errors';
}

/** 生成幂等键（批任务受理必填）。 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function useProblemVersions() {
  const { api } = useApi();

  // ── 草稿与版本（编辑者） ──

  /** 读取共享草稿（无草稿行时服务端返回派生初值）。 */
  function getDraft(problemId: string) {
    return api
      .get<{ data: ProblemDraftView }>(`/api/v1/problems/${problemId}/draft`)
      .then((r) => r.data);
  }

  /** 保存草稿（乐观锁：`expectedRevision` 必传，缺失服务端 428、过时 409）。 */
  function saveDraft(
    problemId: string,
    content: Record<string, unknown>,
    expectedRevision: number,
  ) {
    return api
      .put<{ data: ProblemDraftView }>(
        `/api/v1/problems/${problemId}/draft`,
        { content },
        { headers: { 'If-Match': String(expectedRevision) } },
      )
      .then((r) => r.data);
  }

  /** 发布预检（`verify=false` 时跳过物理对象核实，用于快速反馈）。 */
  function preflight(problemId: string, verify = true) {
    return api
      .get<{ data: PublishPreflightReport }>(
        `/api/v1/problems/${problemId}/draft/preflight${verify ? '' : '?verify=false'}`,
      )
      .then((r) => r.data);
  }

  /** 发布草稿为新版本（相同内容返回 `unchanged: true` 与既有版本）。 */
  function publish(
    problemId: string,
    expectedRevision: number,
    changeNote = '',
  ) {
    return api
      .post<{ data: PublishVersionResult }>(
        `/api/v1/problems/${problemId}/versions`,
        { change_note: changeNote },
        { headers: { 'If-Match': String(expectedRevision) } },
      )
      .then((r) => r.data);
  }

  /** 版本元数据列表（分页，新→旧）。 */
  function listVersions(problemId: string, page = 1, perPage = 20) {
    return api.get<{
      data: ProblemVersionSummary[];
      total: number;
      page: number;
      per_page: number;
    }>(`/api/v1/problems/${problemId}/versions?page=${page}&per_page=${perPage}`);
  }

  /** 指定版本内容（历史版本遵循题目当前访问权限）。 */
  function getVersion(problemId: string, versionId: string) {
    return api
      .get<{ data: ProblemVersionDetail }>(
        `/api/v1/problems/${problemId}/versions/${versionId}`,
      )
      .then((r) => r.data);
  }

  // ── 有效版本策略与竞赛固定版本（管理员） ──

  /** 切换题库有效版本策略（要求预期策略 revision）。 */
  function setProblemPolicy(
    problemId: string,
    policy: EffectiveVersionPolicy,
    expectedRevision: number,
  ) {
    return api.put<{
      data: { revision: number; affected_submissions: number };
    }>(`/api/v1/admin/problems/${problemId}/effective-version-policy`, {
      policy,
      expected_revision: expectedRevision,
    });
  }

  /** 切换「竞赛 × 题目」有效版本策略（`exact(X)` 同时固定作答版本为 X）。 */
  function setContestProblemPolicy(
    contestId: string,
    problemId: string,
    policy: EffectiveVersionPolicy,
    expectedRevision: number,
  ) {
    return api.put<{
      data: { revision: number; affected_submissions: number };
    }>(
      `/api/v1/admin/contests/${contestId}/problems/${problemId}/effective-version-policy`,
      { policy, expected_revision: expectedRevision },
    );
  }

  /** 单独升级竞赛固定作答版本（不撤销旧成绩；可同时提交新策略）。 */
  function setContestProblemVersion(
    contestId: string,
    problemId: string,
    versionId: string,
    options: { policy?: EffectiveVersionPolicy; expectedRevision?: number } = {},
  ) {
    return api.put<{
      data: { pinned_version_id: string; affected_submissions: number };
    }>(`/api/v1/admin/contests/${contestId}/problems/${problemId}/version`, {
      version_id: versionId,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.expectedRevision !== undefined ? { expected_revision: options.expectedRevision } : {}),
    });
  }

  // ── 批量任务（管理员重测 / 用户升级） ──

  /** 受理批量重测任务（`Idempotency-Key` 必填；同键同请求复用原任务）。 */
  function acceptRejudgeJob(
    request: RejudgeRequest,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return api
      .post<{ data: AcceptJobResult }>(
        '/api/v1/admin/submission-jobs',
        request,
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data);
  }

  /** 任务详情（状态与条目计数由持久化条目聚合）。 */
  function getJob(jobId: string) {
    return api
      .get<{ data: SubmissionJobView }>(
        `/api/v1/admin/submission-jobs/${jobId}`,
      )
      .then((r) => r.data);
  }

  /** 任务条目列表（可选按状态过滤）。 */
  function listJobItems(
    jobId: string,
    params: { page?: number; perPage?: number; status?: string } = {},
  ) {
    const query = new URLSearchParams();
    query.set('page', String(params.page ?? 1));
    query.set('per_page', String(params.perPage ?? 20));
    if (params.status) query.set('status', params.status);
    return api.get<{
      data: SubmissionJobItemView[];
      total: number;
      page: number;
      per_page: number;
    }>(`/api/v1/admin/submission-jobs/${jobId}/items?${query.toString()}`);
  }

  /** 重试失败/跳过条目（生成关联新任务，保留目标版本映射）。 */
  function retryJob(jobId: string, idempotencyKey = newIdempotencyKey()) {
    return api
      .post<{ data: AcceptJobResult }>(
        `/api/v1/admin/submission-jobs/${jobId}/retry`,
        undefined,
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data);
  }

  /** 受理用户升级任务（本人提交；`context = source_contest` 时留在原竞赛）。 */
  function acceptUpgradeJob(
    submissions: Array<{ kind: 'submission' | 'objective'; id: string }>,
    context: 'practice' | 'source_contest' = 'practice',
    idempotencyKey = newIdempotencyKey(),
  ) {
    return api
      .post<{ data: AcceptJobResult }>(
        '/api/v1/submission-upgrade-jobs',
        { submissions, context },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      )
      .then((r) => r.data);
  }

  /** 读取升级任务（本人或管理员）。 */
  function getUpgradeJob(jobId: string) {
    return api
      .get<{ data: UpgradeJobView }>(
        `/api/v1/submission-upgrade-jobs/${jobId}`,
      )
      .then((r) => r.data);
  }

  /**
   * 轮询任务直到终态（管理端进度展示用）。
   *
   * 终态由持久化条目聚合得出，因此页面刷新/多标签页都能自愈；本函数只是便捷封装，
   * 不维护任何进程内统计。
   */
  async function waitForJobTerminal(
    jobId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<SubmissionJobView> {
    const interval = options.intervalMs ?? 2000;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      const job = await getJob(jobId);
      if (isJobTerminal(job.status) || Date.now() > deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  return {
    getDraft,
    saveDraft,
    preflight,
    publish,
    listVersions,
    getVersion,
    setProblemPolicy,
    setContestProblemPolicy,
    setContestProblemVersion,
    acceptRejudgeJob,
    getJob,
    listJobItems,
    retryJob,
    acceptUpgradeJob,
    getUpgradeJob,
    waitForJobTerminal,
  };
}
