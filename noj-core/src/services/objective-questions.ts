/**
 * 客观题小题 CRUD + 套卷详情组装。
 *
 * 权限：套卷遵循 U 型规则（owner/admin 可管理小题）；
 * 答案可见性裁剪集中在此服务层（路由不直接回传原始行）：
 * - owner/admin 视图：含 answer / explanation
 * - 公开视图：裁剪 answer / explanation
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/connection.ts";
import { objectiveQuestions, problems } from "../db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import { assertPermission } from "../lib/permissions.ts";
import {
  type CreateQuestionInput,
  JUDGE_OPTIONS,
  type ObjectiveOption,
  type ObjectiveQuestionResponse,
  type QuestionType,
  type UpdateQuestionInput,
  validateAnswerForType,
  validateOptions,
} from "../types/objective.ts";

/** 套卷行类型（problems 表 type='O' 行）。 */
export type PaperRow = typeof problems.$inferSelect;

/** 判断题固定选项（对/错）。 */
export function judgeOptions(): ObjectiveOption[] {
  return JUDGE_OPTIONS.map((o) => ({ key: o.key, text: o.text }));
}

/** 按 id 查询套卷（problems 行），不存在抛 404。 */
export async function getPaperOrThrow(paperId: string): Promise<PaperRow> {
  const db = getDb();
  const rows = await db.select().from(problems).where(eq(problems.id, paperId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError("套卷不存在");
  }
  return rows[0];
}

/** 校验套卷标记为客观题（is_objective=true）。 */
export function assertObjectivePaper(paper: PaperRow): void {
  if (!paper.is_objective) {
    throw new BadRequestError(
      "该题目不是客观题套卷（is_objective 必须为 true）",
    );
  }
}

/** 判断套卷是否可管理/查看答案（权限随题目类型）：
 * - P 型主题库：仅 admin（problem:write_any）
 * - U 型：owner / admin
 */
export async function isPaperOwnerOrAdmin(
  paper: PaperRow,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<boolean> {
  // P 型：仅 admin 可管理（含查看答案）
  if (paper.type === "P") {
    if (userRole === "admin") return true;
    if (c) {
      try {
        await assertPermission(c, "problem:write_any");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  // U 型：owner / admin
  if (paper.owner_id === (c?.var.userId ?? userId)) return true;
  if (userRole === "admin") return true;
  if (c) {
    try {
      await assertPermission(c, "problem:write_any");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 断言套卷可管理（owner/admin），否则抛 403。 */
export async function assertPaperManageable(
  paper: PaperRow,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<void> {
  if (await isPaperOwnerOrAdmin(paper, userId, userRole, c)) return;
  throw new ForbiddenError("无权限管理该套卷");
}

/**
 * 序列化小题响应：owner/admin 含答案与解析，公开视图裁剪。
 */
export function serializeQuestion(
  row: typeof objectiveQuestions.$inferSelect,
  includeAnswer: boolean,
): ObjectiveQuestionResponse {
  const base: ObjectiveQuestionResponse = {
    id: row.id,
    paper_id: row.paper_id,
    sort_order: row.sort_order,
    type: row.type as QuestionType,
    prompt: row.prompt,
    options: row.options as ObjectiveOption[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includeAnswer) {
    base.answer = row.answer as ObjectiveQuestionResponse["answer"];
    base.explanation = row.explanation;
  }
  return base;
}

/**
 * 获取套卷小题列表（按 sort_order 升序）。
 * includeAnswer=true 时返回答案与解析（owner/admin）。
 */
export async function listPaperQuestions(
  paperId: string,
  includeAnswer: boolean,
): Promise<ObjectiveQuestionResponse[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.paper_id, paperId))
    .orderBy(asc(objectiveQuestions.sort_order));
  return rows.map((row) => serializeQuestion(row, includeAnswer));
}

/**
 * 创建小题（绑定套卷）。
 *
 * - 套卷必须存在且 type='O'
 * - owner/admin 可创建
 * - sort_order 默认 MAX+1 追加到末尾；多选/单选答案按题型校验
 * - judge 型忽略传入 options，使用固定对/错选项
 */
export async function createQuestion(
  paperId: string,
  input: CreateQuestionInput,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<ObjectiveQuestionResponse> {
  const db = getDb();
  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  await assertPaperManageable(paper, userId, userRole, c);

  const type = input.type;
  if (!type || !(typeof type === "string")) {
    throw new BadRequestError("缺少必填字段：type");
  }
  if (!(type === "single" || type === "multiple" || type === "judge")) {
    throw new BadRequestError("非法题型：仅允许 single/multiple/judge");
  }
  if (!input.prompt) {
    throw new BadRequestError("缺少必填字段：prompt");
  }

  // 答案按题型校验（single 恰好 1 个、judge 布尔、multiple 非空不重复）
  try {
    validateAnswerForType(type, input.answer);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }

  // 选项校验：judge 型使用固定对/错；其余必须提供合法选项数组
  let options: ObjectiveOption[];
  if (type === "judge") {
    options = judgeOptions();
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
    // 答案必须存在于选项中（judge 型跳过）
    for (const key of input.answer as string[]) {
      if (!options.some((o) => o.key === key)) {
        throw new BadRequestError(`答案选项 ${key} 不存在于选项中`);
      }
    }
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // sort_order：默认追加到末尾（MAX+1）；显式传入必须为非负整数
  let sortOrder = input.sort_order;
  if (sortOrder === undefined) {
    const maxResult = await db
      .select({
        max: sql<number>`COALESCE(MAX(${objectiveQuestions.sort_order}), -1)`,
      })
      .from(objectiveQuestions)
      .where(eq(objectiveQuestions.paper_id, paperId));
    sortOrder = (maxResult[0]?.max ?? -1) + 1;
  } else if (!Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new BadRequestError("sort_order 必须是非负整数");
  }

  const row = {
    id,
    paper_id: paperId,
    sort_order: sortOrder,
    type,
    prompt: input.prompt,
    options,
    answer: input.answer,
    explanation: input.explanation ?? "",
    created_at: now,
    updated_at: now,
  };
  try {
    await db.insert(objectiveQuestions).values(row);
  } catch (err) {
    // sort_order 撞 UNIQUE(paper_id, sort_order) → 400 而非裸 500
    const pgCode = (err as Record<string, unknown>)?.code ??
      ((err as Record<string, unknown>)?.cause as Record<string, unknown>)
        ?.code;
    if (pgCode === "23505") {
      throw new BadRequestError(`排序号 ${sortOrder} 已存在，请调整后重试`);
    }
    throw err;
  }
  return serializeQuestion(row as typeof objectiveQuestions.$inferSelect, true);
}

/**
 * 更新小题（部分更新）。
 * 权限按所属套卷 owner/admin 判断。
 */
export async function updateQuestion(
  questionId: string,
  input: UpdateQuestionInput,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<ObjectiveQuestionResponse> {
  const db = getDb();
  const rows = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.id, questionId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError("小题不存在");
  }
  const existing = rows[0];
  const paper = await getPaperOrThrow(existing.paper_id);
  await assertPaperManageable(paper, userId, userRole, c);

  const updates: Record<string, unknown> = {};
  let nextType = existing.type;
  let nextAnswer = existing.answer;
  let nextOptions = existing.options;

  if (input.type !== undefined) {
    if (
      !(input.type === "single" || input.type === "multiple" ||
        input.type === "judge")
    ) {
      throw new BadRequestError("非法题型：仅允许 single/multiple/judge");
    }
    const typeChanged = input.type !== existing.type;
    nextType = input.type;
    // 改题型时校验既有答案对新题型是否仍合法
    // （否则旧答案入库后该题永远无法答对，且 JSONB 无 DB 层约束兜底）
    if (typeChanged && input.answer === undefined) {
      try {
        validateAnswerForType(nextType, nextAnswer);
      } catch {
        throw new BadRequestError(
          "题型变更后现有答案不合法，请同时提交新的 answer",
        );
      }
    }
    if (typeChanged) {
      if (nextType === "judge") {
        // judge 型固定对/错选项，旧自定义选项作废
        nextOptions = judgeOptions();
      } else if (existing.type === "judge" && input.options === undefined) {
        // 由判断题改为其他题型：固定对/错选项不可复用，必须显式提供
        throw new BadRequestError(
          "由判断题改为其他题型时，必须同时提供 options 与 answer",
        );
      }
    }
  }
  if (input.prompt !== undefined) {
    if (!input.prompt) throw new BadRequestError("prompt 不能为空");
    updates.prompt = input.prompt;
  }
  if (input.answer !== undefined) {
    try {
      validateAnswerForType(nextType, input.answer);
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
    nextAnswer = input.answer;
  }
  if (input.options !== undefined) {
    if (nextType === "judge") {
      throw new BadRequestError("判断题选项不可自定义（固定对/错）");
    }
    try {
      validateOptions(input.options);
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
    nextOptions = input.options;
  }
  // 答案选项必须存在于选项中（judge 型跳过）
  if (nextType !== "judge") {
    const opts = nextOptions as ObjectiveOption[];
    for (const key of nextAnswer as string[]) {
      if (!opts.some((o) => o.key === key)) {
        throw new BadRequestError(`答案选项 ${key} 不存在于选项中`);
      }
    }
  }
  if (input.explanation !== undefined) {
    updates.explanation = input.explanation;
  }
  if (input.sort_order !== undefined) {
    if (!Number.isInteger(input.sort_order) || input.sort_order < 0) {
      throw new BadRequestError("sort_order 必须是非负整数");
    }
    updates.sort_order = input.sort_order;
  }

  if (nextType !== existing.type) updates.type = nextType;
  if (JSON.stringify(nextAnswer) !== JSON.stringify(existing.answer)) {
    updates.answer = nextAnswer;
  }
  if (JSON.stringify(nextOptions) !== JSON.stringify(existing.options)) {
    updates.options = nextOptions;
  }
  updates.updated_at = new Date().toISOString();

  try {
    await db.update(objectiveQuestions).set(updates).where(
      eq(objectiveQuestions.id, questionId),
    );
  } catch (err) {
    // sort_order 撞 UNIQUE(paper_id, sort_order) → 400 而非裸 500
    const pgCode = (err as Record<string, unknown>)?.code ??
      ((err as Record<string, unknown>)?.cause as Record<string, unknown>)
        ?.code;
    if (pgCode === "23505") {
      throw new BadRequestError("排序号冲突，请调整后重试");
    }
    throw err;
  }

  const updated = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.id, questionId))
    .limit(1);
  return serializeQuestion(updated[0], true);
}

/**
 * 删除小题。
 * 权限按所属套卷 owner/admin 判断。
 */
export async function deleteQuestion(
  questionId: string,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.id, questionId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError("小题不存在");
  }
  const existing = rows[0];
  const paper = await getPaperOrThrow(existing.paper_id);
  await assertPaperManageable(paper, userId, userRole, c);
  await db.delete(objectiveQuestions).where(
    eq(objectiveQuestions.id, questionId),
  );
}
