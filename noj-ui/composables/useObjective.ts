import { useApi } from './useApi';

/**
 * 客观题（objective）API 层（issue #222）。
 *
 * 套卷 CRUD 复用 /api/v1/problems（type='O'），
 * 小题与提交走 /api/v1/objective/*。
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
}

export interface ObjectivePaper {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  number: number;
  type: 'O';
  display_id: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface QuestionJudgement {
  correct: boolean;
  expected?: (string | boolean)[];
  given: (string | boolean)[];
  explanation?: string;
}

export interface SubmitResult {
  submission_id: string;
  paper_id: string;
  score: number;
  score_db: number;
  correct_count: number;
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
  score: number;
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

/** 题型中文标签 */
export const QUESTION_TYPE_LABELS: Record<ObjectiveQuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
};

export function useObjective() {
  const { api } = useApi();

  /** 套卷列表（type=O） */
  function listPapers(page = 1, limit = 20) {
    return api.get<{ data: ObjectivePaper[]; total: number; page: number; limit: number }>(
      `/api/v1/problems?type=O&page=${page}&limit=${limit}`,
    );
  }

  /** 套卷详情 */
  function getPaper(id: string) {
    return api.get<{ data: ObjectivePaper }>(`/api/v1/problems/${id}`);
  }

  /** 创建套卷（type=O，无需 runtime_config） */
  function createPaper(payload: { title: string; description: string }) {
    return api.post<{ data: ObjectivePaper }>('/api/v1/problems', {
      ...payload,
      type: 'O',
    });
  }

  /** 更新套卷元信息 */
  function updatePaper(id: string, payload: { title?: string; description?: string }) {
    return api.put<{ data: ObjectivePaper }>(`/api/v1/problems/${id}`, payload);
  }

  /** 删除套卷（级联删除小题与提交） */
  function deletePaper(id: string) {
    return api.delete<null>(`/api/v1/problems/${id}`);
  }

  /** 小题列表（owner/admin 含答案，其余裁剪） */
  function listQuestions(paperId: string) {
    return api.get<{ data: ObjectiveQuestion[] }>(
      `/api/v1/objective/papers/${paperId}/questions`,
    );
  }

  /** 创建小题 */
  function createQuestion(paperId: string, payload: QuestionInput) {
    return api.post<{ data: ObjectiveQuestion }>(
      `/api/v1/objective/papers/${paperId}/questions`,
      payload,
    );
  }

  /** 更新小题 */
  function updateQuestion(questionId: string, payload: Partial<QuestionInput>) {
    return api.put<{ data: ObjectiveQuestion }>(
      `/api/v1/objective/questions/${questionId}`,
      payload,
    );
  }

  /** 删除小题 */
  function deleteQuestion(questionId: string) {
    return api.delete<null>(`/api/v1/objective/questions/${questionId}`);
  }

  /** 提交套卷答案（即时判定；竞赛提交携带 contest_id） */
  function submitPaper(
    paperId: string,
    answers: Record<string, (string | boolean)[]>,
    contestId?: string,
  ) {
    return api.post<{ data: SubmitResult }>(`/api/v1/objective/papers/${paperId}/submit`, {
      answers,
      ...(contestId ? { contest_id: contestId } : {}),
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
      `/api/v1/objective/submissions${qs ? `?${qs}` : ''}`,
    );
  }

  /** 单次提交详情 */
  function getSubmission(id: string) {
    return api.get<{ data: ObjectiveSubmission }>(`/api/v1/objective/submissions/${id}`);
  }

  return {
    listPapers,
    getPaper,
    createPaper,
    updatePaper,
    deletePaper,
    listQuestions,
    createQuestion,
    updateQuestion,
    deleteQuestion,
    submitPaper,
    listSubmissions,
    getSubmission,
  };
}
