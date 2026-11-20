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

  /**
   * 版本元数据列表（分页，新→旧）。
   *
   * `options.silent` 用于非关键渲染（如题目详情页的版本选择器）：失败不弹 toast，
   * 由调用方降级为"不展示选择器"。
   */
  function listVersions(
    problemId: string,
    page = 1,
    perPage = 20,
    options: { silent?: boolean } = {},
  ) {
    const url = `/api/v1/problems/${problemId}/versions?page=${page}&per_page=${perPage}`;
    return api.get<{
      data: ProblemVersionSummary[];
      total: number;
      page: number;
      per_page: number;
    }>(url, options.silent ? { silent: true } : undefined);
  }

  /** 指定版本内容（历史版本遵循题目当前访问权限）。 */
  function getVersion(problemId: string, versionId: string) {
    return api
      .get<{ data: ProblemVersionDetail }>(
        `/api/v1/problems/${problemId}/versions/${versionId}`,
      )
      .then((r) => r.data);
  }

  return {
    getDraft,
    saveDraft,
    preflight,
    publish,
    listVersions,
    getVersion,
  };
}
