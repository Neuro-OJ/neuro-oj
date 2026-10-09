/**
 * 客观题小题的草稿写入与版本快照读取（Handbook §6.4）。
 *
 * 核心不变量：
 * - 小题保存到**草稿 content**，不直接改题目投影/旧小题表；
 * - 小题 `key` 在同题跨版本稳定：编辑保留 key、新增生成 UUID、导入必须显式给出
 *   key（**不按序号或题干猜测**旧小题对应关系）；
 * - 已发布小题从**版本快照**读取，重判与历史查看都以快照为准；
 * - 标识按题目作用域解释——`key` 只在所属题目内有意义。
 */

import { eq } from "drizzle-orm";
import {
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { problems, problemVersions } from "../../../../shared/db/schema.ts";
import {
  getProblemDraft,
  type ObjectiveQuestionSnapshot,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  problemContentKindOf,
  type ProblemDraftContent,
  saveProblemDraft,
} from "../../../catalog/index.ts";
import {
  JUDGE_OPTIONS,
  type ObjectiveAnswerValue,
  type ObjectiveOption,
  validateAnswerForType,
  validateOptions,
} from "../../types/objective.ts";

/** 小题写入输入（`key` 仅导入路径显式提供）。 */
export interface ObjectiveQuestionInput {
  /** 仅导入/迁移允许显式指定；Web 新增不提供（服务端生成 UUID）。 */
  key?: string;
  type: string;
  prompt: string;
  options?: ObjectiveOption[];
  answer: ObjectiveAnswerValue[];
  explanation?: string;
  sort_order?: number;
}

/** 读取客观题草稿（题目必须存在且为客观题套卷）。 */
async function loadObjectiveDraft(
  problemId: string,
  executor?: Executor,
): Promise<{ revision: number; content: ProblemDraftContent }> {
  const db = executor ?? getDb();
  const [identity] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  ).limit(1);
  if (!identity) {
    throw new BadRequestError("套卷不存在");
  }
  if (problemContentKindOf(identity) !== "objective") {
    throw new BadRequestError("该题目不是客观题套卷");
  }
  const draft = await getProblemDraft(problemId, identity, db);
  if (draft.content.kind !== "objective") {
    throw new BadRequestError("草稿内容不是客观题内容");
  }
  return { revision: draft.revision, content: draft.content };
}

/** 读取草稿小题（按 sort_order、key 稳定排序）。 */
export async function listDraftQuestions(
  problemId: string,
  executor?: Executor,
): Promise<ObjectiveQuestionSnapshot[]> {
  const { content } = await loadObjectiveDraft(problemId, executor);
  return sortQuestions(
    (content.questions as ObjectiveQuestionSnapshot[] | undefined) ?? [],
  );
}

/** 读取指定已发布版本的小题快照。 */
export async function listVersionQuestions(
  versionId: string,
  executor?: Executor,
): Promise<ObjectiveQuestionSnapshot[]> {
  const db = executor ?? getDb();
  const [row] = await db.select({ content: problemVersions.content }).from(
    problemVersions,
  ).where(eq(problemVersions.id, versionId)).limit(1);
  if (!row) {
    throw new BadRequestError("题目版本不存在");
  }
  const content = row.content as ProblemDraftContent | null;
  if (!content || content.kind !== "objective") {
    return [];
  }
  return sortQuestions(
    (content.questions as ObjectiveQuestionSnapshot[] | undefined) ?? [],
  );
}

/**
 * 重判/判卷使用的题目集合解析（Handbook §6.4）：
 * 目标版本的小题快照就是唯一事实源；快照缺失小题时返回空集合（按未作答处理）。
 */
export async function resolveQuestionsForJudging(
  versionId: string,
  executor?: Executor,
): Promise<ObjectiveQuestionSnapshot[]> {
  return await listVersionQuestions(versionId, executor);
}

function sortQuestions(
  questions: readonly ObjectiveQuestionSnapshot[],
): ObjectiveQuestionSnapshot[] {
  return [...questions].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** 校验并规范化一条小题输入（返回不含 key/sort_order 的部分）。 */
function normalizeQuestionInput(
  input: ObjectiveQuestionInput,
  fallbackSortOrder: number,
): Omit<ObjectiveQuestionSnapshot, "key"> {
  if (
    typeof input.type !== "string" ||
    !["single", "multiple", "judge"].includes(input.type)
  ) {
    throw new BadRequestError("非法题型：仅允许 single/multiple/judge");
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new BadRequestError("缺少必填字段：prompt");
  }
  try {
    validateAnswerForType(input.type, input.answer);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }
  let options: ObjectiveOption[];
  if (input.type === "judge") {
    options = JUDGE_OPTIONS.map((option) => ({ ...option }));
  } else {
    if (input.options === undefined) {
      throw new BadRequestError("缺少必填字段：options");
    }
    try {
      validateOptions(input.options);
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
    options = input.options;
    for (const key of input.answer as string[]) {
      if (!options.some((option) => option.key === key)) {
        throw new BadRequestError(`答案选项 ${key} 不存在于选项中`);
      }
    }
  }
  const sortOrder = input.sort_order ?? fallbackSortOrder;
  if (!Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new BadRequestError("sort_order 必须是非负整数");
  }
  return {
    sort_order: sortOrder,
    type: input.type as ObjectiveQuestionSnapshot["type"],
    prompt: input.prompt,
    options,
    answer: input.answer,
    explanation: input.explanation ?? "",
  };
}

/** 把小题集合写回草稿（revision 递增一次）。 */
async function persistQuestions(
  problemId: string,
  content: ProblemDraftContent,
  questions: ObjectiveQuestionSnapshot[],
  expectedRevision: number | null | undefined,
  actorId?: string | null,
): Promise<ObjectiveQuestionSnapshot[]> {
  const next = sortQuestions(questions);
  await saveProblemDraft(problemId, {
    content: { ...content, kind: "objective", questions: next },
    expectedRevision,
    actorId,
  });
  return next;
}

/**
 * 新增小题（整卷草稿，revision 递增一次）。
 *
 * `key` 未提供时生成 UUID；提供时必须非空且不与现有小题冲突（导入路径）。
 */
export async function createDraftQuestion(
  problemId: string,
  input: ObjectiveQuestionInput,
  expectedRevision: number | null | undefined,
  actorId?: string | null,
): Promise<ObjectiveQuestionSnapshot> {
  const { content } = await loadObjectiveDraft(problemId);
  const questions = (content.questions as ObjectiveQuestionSnapshot[]) ?? [];
  const key = input.key?.trim() || crypto.randomUUID();
  if (questions.some((question) => question.key === key)) {
    throw new ConflictError(`小题 key 已存在：${key}`);
  }
  const normalized = normalizeQuestionInput(input, questions.length);
  const created: ObjectiveQuestionSnapshot = { key, ...normalized };
  await persistQuestions(
    problemId,
    content,
    [...questions, created],
    expectedRevision,
    actorId,
  );
  return created;
}

/** 更新小题（按 key 定位；key 保持不变）。 */
export async function updateDraftQuestion(
  problemId: string,
  key: string,
  input: Partial<ObjectiveQuestionInput>,
  expectedRevision: number | null | undefined,
  actorId?: string | null,
): Promise<ObjectiveQuestionSnapshot> {
  const { content } = await loadObjectiveDraft(problemId);
  const questions = (content.questions as ObjectiveQuestionSnapshot[]) ?? [];
  const index = questions.findIndex((question) => question.key === key);
  if (index < 0) {
    throw new BadRequestError(`小题不存在：${key}`);
  }
  const existing = questions[index];
  const normalized = normalizeQuestionInput({
    type: input.type ?? existing.type,
    prompt: input.prompt ?? existing.prompt,
    options: input.options ?? existing.options,
    answer: input.answer ?? existing.answer,
    explanation: input.explanation ?? existing.explanation,
    sort_order: input.sort_order ?? existing.sort_order,
  }, existing.sort_order);
  const updated: ObjectiveQuestionSnapshot = { key, ...normalized };
  const next = [...questions];
  next[index] = updated;
  await persistQuestions(problemId, content, next, expectedRevision, actorId);
  return updated;
}

/** 删除小题（按 key；删除后不参与判分）。 */
export async function deleteDraftQuestion(
  problemId: string,
  key: string,
  expectedRevision: number | null | undefined,
  actorId?: string | null,
): Promise<void> {
  const { content } = await loadObjectiveDraft(problemId);
  const questions = (content.questions as ObjectiveQuestionSnapshot[]) ?? [];
  if (!questions.some((question) => question.key === key)) {
    throw new BadRequestError(`小题不存在：${key}`);
  }
  await persistQuestions(
    problemId,
    content,
    questions.filter((question) => question.key !== key),
    expectedRevision,
    actorId,
  );
}

/**
 * 整卷替换（导入路径）。
 *
 * 每条必须显式携带 `key`：导入流程**不得**按序号或题干猜测旧小题对应关系。
 */
export async function replaceDraftQuestions(
  problemId: string,
  questions: readonly ObjectiveQuestionSnapshot[],
  expectedRevision: number | null | undefined,
  actorId?: string | null,
): Promise<ObjectiveQuestionSnapshot[]> {
  const { content } = await loadObjectiveDraft(problemId);
  const keys = new Set<string>();
  const normalized: ObjectiveQuestionSnapshot[] = [];
  for (const question of questions) {
    if (typeof question.key !== "string" || question.key.length === 0) {
      throw new BadRequestError("导入的小题必须携带 key");
    }
    if (keys.has(question.key)) {
      throw new BadRequestError(`小题 key 重复：${question.key}`);
    }
    keys.add(question.key);
    const base = normalizeQuestionInput({
      type: question.type,
      prompt: question.prompt,
      options: question.options,
      answer: question.answer,
      explanation: question.explanation,
      sort_order: question.sort_order,
    }, normalized.length);
    normalized.push({ key: question.key, ...base });
  }
  return await persistQuestions(
    problemId,
    content,
    normalized,
    expectedRevision,
    actorId,
  );
}

/** 草稿当前是否有尚未保存的内容（供路由返回编辑初值）。 */
export function isVirtualDraftRevision(revision: number): boolean {
  return revision === PROBLEM_DRAFT_VIRTUAL_REVISION;
}
