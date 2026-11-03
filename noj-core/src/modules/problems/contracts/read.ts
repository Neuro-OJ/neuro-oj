/**
 * problems 对外的只读快照合同。
 *
 * contests 只通过这里读取题目内容、固定版本和来源共享事实。实现只依赖
 * problems 自己的类型/表以及共享的访问事实，不导入 problems service 门面，
 * 因而不会把 contests ↔ problems 运行时环重新引入。
 */
import { and, eq } from "drizzle-orm";
import type { DbRoot } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { problemVersions } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import type { ProblemReference } from "../../../shared/workspace/types.ts";
import type {
  ObjectiveOption,
  ObjectiveQuestionResponse,
  QuestionType,
} from "../types/objective.ts";
import type {
  ObjectiveQuestionSnapshot,
  ProblemContentV1,
} from "../types/problem-content.ts";
import type { ProblemRuntimeConfig } from "../types/problems.ts";
import { getJudgeBackend } from "../types/runtime-config.ts";
import {
  getSubmissionLanguages,
  isValidSubmissionMode,
  type SubmissionMode,
} from "../types/problems.ts";

/** 只读查询最小根连接能力；不暴露业务门面或 Executor 联合类型。 */
type ReadExecutor = Pick<DbRoot, "select">;

/** 评测侧使用的不可变版本快照。 */
export type ProblemVersionSnapshot = Readonly<{
  problemId: string;
  versionId: string;
  version: number;
  content: ProblemContentV1;
  submissionMode: string;
  judgeType: "dual" | "oi";
}>;

/** 题目共享/撤销策略的不可变事实。 */
export type ProblemAccessDecision = Readonly<{
  problemId: string;
  allowed: boolean;
  canSubmit: boolean;
  mode: "public" | "private" | "contest-secret" | "denied";
  sourceDomainId?: string | null;
  bindingId?: string | null;
}>;

/** 题目引用的公开共享事实，供 contests 在固定版本前复核。 */
export type ProblemShareSnapshot = Readonly<{
  problemId: string;
  sourceDomainId: string;
  targetDomainId: string;
  shared: boolean;
}>;

/** 默认旧入口的来源约束。 */
export function assertDefaultProblemSource(
  source: { domain_id: string },
): void {
  if (source.domain_id !== DEFAULT_DOMAIN_ID) {
    throw new NotFoundError("默认域不存在此题");
  }
}

/** 跨域来源引用的稳定展示 DTO。 */
export function domainProblemReference(
  problem: { id: string; domain_id: string; number: number },
  sourceSlug: string,
  consumingDomainId: string,
): ProblemReference {
  const qualified = `${sourceSlug}:${problem.number}`;
  const shared = problem.domain_id !== consumingDomainId;
  return {
    problem_id: problem.id,
    source_domain_id: problem.domain_id,
    source_domain_slug: sourceSlug,
    number: problem.number,
    qualified_ref: qualified,
    display_ref: shared ? qualified : String(problem.number),
  };
}

/** 版本内容投影；题目管理元数据不属于该合同。 */
export function projectProblemContent(
  content: ProblemContentV1,
  includePrivileged: boolean,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    title: content.title,
    description: content.description,
    samples: content.samples ?? [],
  };
  const runtime = content.kind === "oi"
    ? content.runtime_config
    : content.kind === "ai"
    ? content.runtime_config?.evaluator
    : null;
  overrides.limits = runtime
    ? {
      time_limit_ms: runtime.time_limit_ms,
      memory_limit_mb: runtime.memory_limit_mb,
    }
    : null;
  if (content.kind === "ai") {
    overrides.judge_type = "dual";
    overrides.judge_backend = getJudgeBackend(
      "dual",
      content.runtime_config,
      false,
    );
    overrides.is_objective = false;
    overrides.submission_mode = content.submission_mode;
    overrides.artifact_max_size_mb = content.artifact_max_size_mb;
    overrides.supported_languages = getSubmissionLanguages(
      "dual",
      content.runtime_config,
    );
    if (includePrivileged) {
      overrides.runtime_config = content.runtime_config;
      overrides.llm_config = content.llm_config;
      overrides.template_content = content.template_content;
    }
    return overrides;
  }
  if (content.kind === "oi") {
    overrides.judge_type = "oi";
    overrides.judge_backend = getJudgeBackend(
      "oi",
      content.runtime_config,
      false,
    );
    overrides.is_objective = false;
    overrides.submission_mode = "code";
    overrides.artifact_max_size_mb = null;
    overrides.supported_languages = getSubmissionLanguages(
      "oi",
      content.runtime_config,
    );
    if (includePrivileged) overrides.runtime_config = content.runtime_config;
    return overrides;
  }
  overrides.is_objective = true;
  overrides.judge_type = "dual";
  overrides.judge_backend = getJudgeBackend("dual", null, true);
  overrides.submission_mode = "code";
  overrides.artifact_max_size_mb = null;
  overrides.supported_languages = [];
  overrides.runtime_config = null;
  overrides.questions = includePrivileged
    ? content.questions
    : content.questions.map((question) => ({
      ...question,
      answer: [],
      explanation: "",
    }));
  return overrides;
}

/** 竞赛内容 DTO 的稳定小题序列化，不依赖 objective 判分服务。 */
export function serializeQuestion(
  paperId: string,
  question: ObjectiveQuestionSnapshot,
  includeAnswer: boolean,
): ObjectiveQuestionResponse {
  const result: ObjectiveQuestionResponse = {
    id: question.key,
    paper_id: paperId,
    sort_order: question.sort_order,
    type: question.type as QuestionType,
    prompt: question.prompt,
    options: question.options as ObjectiveOption[],
    created_at: "",
    updated_at: "",
  };
  if (includeAnswer) {
    result.answer = question.answer;
    result.explanation = question.explanation;
  }
  return result;
}

/** 题目固定版本快照查询。 */
export async function getProblemVersionSnapshot(
  problemId: string,
  versionId: string,
  executor: ReadExecutor = getDb(),
): Promise<ProblemVersionSnapshot | null> {
  const [row] = await executor.select({
    problemId: problemVersions.problem_id,
    versionId: problemVersions.id,
    version: problemVersions.version,
    content: problemVersions.content,
  }).from(problemVersions).where(and(
    eq(problemVersions.problem_id, problemId),
    eq(problemVersions.id, versionId),
  )).limit(1);
  if (!row) return null;
  const content = row.content as ProblemContentV1;
  return {
    problemId: row.problemId,
    versionId: row.versionId,
    version: row.version,
    content,
    submissionMode: content.kind === "ai" ? content.submission_mode : "code",
    judgeType: content.kind === "oi" ? "oi" : "dual",
  };
}

/** 题目运行期配置类型只读导出。 */
export type { ProblemContentV1, ProblemRuntimeConfig };
export { getJudgeBackend, getSubmissionLanguages, isValidSubmissionMode };
export type { SubmissionMode };
