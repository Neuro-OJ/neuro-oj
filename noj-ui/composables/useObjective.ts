import { useApi } from './useApi';

/**
 * 客观题（objective）API 层（issue #222，并入 problems 体系）。
 *
 * 套卷即 problems 表中的 is_objective=true 题目（type 仍为 U/P，权限随类型）；
 * 小题与提交挂在 /api/v1/problems/:id/* 下。
 */

export type ObjectiveQuestionType = 'single' | 'multiple' | 'judge';

export interface ObjectiveOption {
  key: string;
  text: string;
}

export interface ObjectiveQuestion {
  id: string;
  paper_id: string;
  sort_order: number;
  type: ObjectiveQuestionType;
  prompt: string;
  options: ObjectiveOption[];
  /** 仅 owner/admin 视图或判卷后返回 */
  answer?: (string | boolean)[];
  explanation?: string;
  created_at: string;
  updated_at: string;
  /** 写入响应附带的最新草稿 revision（继续写入时的乐观锁取值） */
  draft_revision?: number;
}

export interface ObjectivePaper {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  number: number;
  /** 题目类型：U（用户题）/ P（主题题），权限随类型 */
  type: 'U' | 'P';
  /** 客观题标记（并入 problems 体系） */
  is_objective: boolean;
  owner_id: string;
  display_id: string;
  tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[];
  created_at: string;
  updated_at: string;
}

/**
 * 单题判定结果。
 *
 * 竞赛模式（VULN-03）：比赛结束前后端**不返回** `correct` / `expected` / `explanation`，
 * 只返回 `given`（你的作答）；因此 `correct` 为可选，缺失即"尚无判定信息"，
 * 调用方不得把它当成 `false`（否则会把未公布渲染成"回答错误"）。
 */
export interface QuestionJudgement {
  correct?: boolean;
  expected?: (string | boolean)[];
  given: (string | boolean)[];
  explanation?: string;
}

/**
 * 客观题提交回执。
 *
 * 竞赛模式（VULN-03）在比赛结束前返回：
 * `{ score: null, score_db: null, correct_count: null, total_count: <题数>, details: {} }`，
 * 即"已提交但成绩未公布"。练习模式照旧为具体分数。
 */
export interface SubmitResult {
  submission_id: string;
  paper_id: string;
  /** 百分制分数（0–100）；竞赛进行中为 null（成绩赛后开放）。 */
  score: number | null;
  score_db: number | null;
  /** 答对题数；竞赛进行中为 null。 */
  correct_count: number | null;
  total_count: number;
  details: Record<string, QuestionJudgement>;
  contest_mode: boolean;
}

export interface ObjectiveSubmission {
  id: string;
  paper_id: string;
  user_id: string;
  contest_id: string | null;
  submission_type: 'practice' | 'contest';
  answers: Record<string, (string | boolean)[]>;
  status: string;
  /** 百分制分数；竞赛进行中为 null（历史列表同样不公布，VULN-03）。 */
  score: number | null;
  details: Record<string, QuestionJudgement>;
  created_at: string;
}

export interface ObjectiveSubmissionList {
  data: ObjectiveSubmission[];
  total: number;
  best_score: number | null;
}

export interface QuestionInput {
  type: ObjectiveQuestionType;
  prompt: string;
  options?: ObjectiveOption[];
  answer: (string | boolean)[];
  explanation?: string;
}

/** 套卷编辑器中的小题草稿（id 为 null 表示新建） */
export interface QuestionDraft {
  id: string | null;
  type: ObjectiveQuestionType;
  prompt: string;
  options: ObjectiveOption[];
  answer: (string | boolean)[];
  explanation: string;
}

/** 题型中文标签 */
export const QUESTION_TYPE_LABELS: Record<ObjectiveQuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
};

export function useObjective() {
  const { api } = useApi();

  /** 套卷列表（并入 problems 体系，由题库列表承担）——保留供后续扩展 */
  function listPapers(page = 1, limit = 20) {
    return api.get<{ data: ObjectivePaper[]; total: number; page: number; limit: number }>(
      `/api/v1/problems?type=U&page=${page}&limit=${limit}`,
    );
  }

  /** 套卷详情 */
  function getPaper(id: string) {
    return api.get<{ data: ObjectivePaper }>(`/api/v1/problems/${id}`);
  }

  /** 创建套卷（is_objective=true，无需 runtime_config；type 默认 U，可 P） */
  function createPaper(payload: { title: string; description: string; type?: 'U' | 'P'; tag_ids?: string[] }) {
    return api.post<{ data: ObjectivePaper }>('/api/v1/problems', {
      ...payload,
      is_objective: true,
    });
  }

  /** 更新套卷元信息 */
  function updatePaper(id: string, payload: { title?: string; description?: string; tag_ids?: string[] }) {
    return api.put<{ data: ObjectivePaper }>(`/api/v1/problems/${id}`, payload);
  }

  /** 删除套卷（级联删除小题与提交） */
  function deletePaper(id: string) {
    return api.delete<null>(`/api/v1/problems/${id}`);
  }

  /** 小题列表（owner/admin（U 型）或 admin（P 型）读草稿含答案，其余读版本快照并裁剪） */
  function listQuestions(paperId: string) {
    return api.get<{ data: ObjectiveQuestion[] }>(
      `/api/v1/problems/${paperId}/questions`,
    );
  }

  /**
   * 读取共享草稿（编辑初值 + 小题写入的乐观锁 revision）。
   *
   * 小题编辑与套卷内容共用同一草稿 revision（Handbook §2.4）：每次写入都必须
   * 携带当前 revision，成功响应回传新值。
   */
  function getDraft(paperId: string) {
    return api.get<{
      data: {
        revision: number;
        base_version_id: string | null;
        content: Record<string, unknown>;
      };
    }>(`/api/v1/problems/${paperId}/draft`);
  }

  /** 发布当前草稿为新版本（相同内容返回既有版本）。 */
  function publishDraft(paperId: string, expectedRevision: number, changeNote = '') {
    return api.post<{
      data: {
        problem_id: string;
        version_id: string;
        version: number;
        draft_revision: number;
        unchanged: boolean;
      };
    }>(
      `/api/v1/problems/${paperId}/versions`,
      { change_note: changeNote },
      { headers: { 'If-Match': String(expectedRevision) } },
    );
  }

  /** 创建小题（写共享草稿，携带 `If-Match: revision`）。 */
  function createQuestion(
    paperId: string,
    payload: QuestionInput,
    expectedRevision: number,
  ) {
    return api.post<{ data: ObjectiveQuestion }>(
      `/api/v1/problems/${paperId}/questions`,
      payload,
      { headers: { 'If-Match': String(expectedRevision) } },
    );
  }

  /** 更新小题（`key` 跨版本稳定，写共享草稿）。 */
  function updateQuestion(
    paperId: string,
    questionId: string,
    payload: Partial<QuestionInput>,
    expectedRevision: number,
  ) {
    return api.put<{ data: ObjectiveQuestion }>(
      `/api/v1/problems/${paperId}/questions/${questionId}`,
      payload,
      { headers: { 'If-Match': String(expectedRevision) } },
    );
  }

  /** 删除小题（写共享草稿；返回删除后的新 revision）。 */
  function deleteQuestion(
    paperId: string,
    questionId: string,
    expectedRevision: number,
  ) {
    return api.delete<{ data: { draft_revision: number } }>(
      `/api/v1/problems/${paperId}/questions/${questionId}`,
      { headers: { 'If-Match': String(expectedRevision) } },
    );
  }

  /**
   * 提交套卷答案（即时判定；竞赛提交携带 contest_id）。
   *
   * `versionId` 为作答版本（Handbook §4.2）：已发布版本的套卷必须携带，
   * 服务端据此记录"在评哪一版"，缺省会被 409 拒绝。
   */
  function submitPaper(
    paperId: string,
    answers: Record<string, (string | boolean)[]>,
    contestId?: string,
    versionId?: string | null,
  ) {
    return api.post<{ data: SubmitResult }>(`/api/v1/problems/${paperId}/submit`, {
      answers,
      ...(contestId ? { contest_id: contestId } : {}),
      ...(versionId ? { version_id: versionId } : {}),
    });
  }

  /** 提交历史（本人）+ 练习最高分 */
  function listSubmissions(params: {
    paperId?: string;
    contestId?: string;
    page?: number;
    perPage?: number;
  }) {
    const query = new URLSearchParams();
    if (params.paperId) query.set('paper_id', params.paperId);
    if (params.contestId) query.set('contest_id', params.contestId);
    if (params.page) query.set('page', String(params.page));
    if (params.perPage) query.set('per_page', String(params.perPage));
    const qs = query.toString();
    return api.get<{ data: ObjectiveSubmissionList }>(
      `/api/v1/problems/submissions${qs ? `?${qs}` : ''}`,
    );
  }

  /** 单次提交详情 */
  function getSubmission(id: string) {
    return api.get<{ data: ObjectiveSubmission }>(`/api/v1/problems/submissions/${id}`);
  }

  return {
    listPapers,
    getPaper,
    createPaper,
    updatePaper,
    deletePaper,
    listQuestions,
    getDraft,
    publishDraft,
    createQuestion,
    updateQuestion,
    deleteQuestion,
    submitPaper,
    listSubmissions,
    getSubmission,
  };
}
