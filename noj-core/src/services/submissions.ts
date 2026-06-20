/**
 * 提交服务
 *
 * 提供提交的业务逻辑。当前使用内存存储。
 */

import type {
  Submission,
  SubmissionSummary,
  CreateSubmissionInput,
  SubmissionWithResult,
  SubmissionStatus,
  EvaluationResult,
} from "../types/submissions.ts";

/** 内存存储的提交数据 */
const submissionsStore: Map<string, Submission> = new Map();

/** 内存存储的评测结果 */
const evaluationResultsStore: Map<string, EvaluationResult> = new Map();

/**
 * 获取提交列表
 */
export function listSubmissions(userId: string): SubmissionSummary[] {
  const submissions: SubmissionSummary[] = [];
  for (const s of submissionsStore.values()) {
    if (s.user_id === userId) {
      const result = evaluationResultsStore.get(s.id);
      submissions.push({
        id: s.id,
        problem_id: s.problem_id,
        language: s.language,
        status: result?.status || s.status,
        created_at: s.created_at,
      });
    }
  }
  return submissions;
}

/**
 * 根据 ID 获取提交详情
 */
export function getSubmission(id: string, userId: string): SubmissionWithResult | undefined {
  const submission = submissionsStore.get(id);
  if (!submission || submission.user_id !== userId) {
    return undefined;
  }

  const result = evaluationResultsStore.get(id);

  return {
    ...submission,
    score: result?.score,
    output: result?.output,
    details: result?.details,
    time_ms: result?.time_ms,
    memory_kb: result?.memory_kb,
    judged_at: result ? submission.created_at : undefined,
  };
}

/**
 * 创建提交
 */
export function createSubmission(
  userId: string,
  input: CreateSubmissionInput
): Submission {
  const id = crypto.randomUUID();
  const fileName = input.file_name || `main.${getFileExtension(input.language)}`;

  const submission: Submission = {
    id,
    user_id: userId,
    problem_id: input.problem_id,
    language: input.language,
    code: input.code,
    file_name: fileName,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  submissionsStore.set(id, submission);
  return submission;
}

/**
 * 获取文件扩展名
 */
function getFileExtension(language: string): string {
  const extensions: Record<string, string> = {
    python3: "py",
    javascript: "js",
    cpp: "cpp",
    java: "java",
    go: "go",
    rust: "rs",
  };
  return extensions[language] || "txt";
}