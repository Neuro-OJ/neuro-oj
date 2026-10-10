/**
 * 客观题套卷读取与小题可见性裁剪（Handbook §6.4）。
 *
 * 内容事实源（批次 2d 起）：
 * - **编辑者**（owner/admin）读**共享草稿**小题，含答案与解析，供编辑；
 * - **作答者/公开视图**读**默认作答版本**的小题快照，答案与解析一律裁剪；
 * - 未发布套卷对非编辑者返回 404（与题目详情口径一致）。
 *
 * 旧 `objective_questions` 表不再作为运行期事实源（仅剩存量兼容读取，
 * 见 `objective-submissions.ts` 的 `legacy_unknown` 回退；批次 7b 删除该表）。
 *
 * 权限：套卷遵循 U 型规则（owner/admin 可管理小题）。
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./../../../shared/db/connection.ts";
import { problems } from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { assertPermission } from "./../../identity/index.ts";
import {
  evaluateProblemAccess,
  type ObjectiveQuestionSnapshot,
  resolveProblemAnswerVersion,
} from "./../../catalog/index.ts";
import { verifyContestAccess } from "./../../contest/index.ts";
import { isUuid } from "./../../../shared/security/public-id.ts";
import {
  JUDGE_OPTIONS,
  type ObjectiveOption,
  type ObjectiveQuestionResponse,
  type QuestionType,
} from "./../types/objective.ts";
import {
  listDraftQuestions,
  listVersionQuestions,
} from "./versioning/objective-drafts.ts";

/** 套卷行类型（problems 表 type='O' 行）。 */
export type PaperRow = typeof problems.$inferSelect;

/** 判断题固定选项（对/错）。 */
export function judgeOptions(): ObjectiveOption[] {
  return JUDGE_OPTIONS.map((o) => ({ key: o.key, text: o.text }));
}

/** 按 id 查询套卷（problems 行），不存在抛 404。支持 UUID / display_id（如 U42）/ 纯数字。 */
export async function getPaperOrThrow(paperId: string): Promise<PaperRow> {
  const paper = await resolvePaperId(paperId);
  if (!paper) {
    throw new NotFoundError("套卷不存在");
  }
  return paper;
}

/**
 * 解析套卷 ID（双索引，同 problem-resolve）：
 * - UUID / 纯数字：直接按 id 精确查找
 * - display_id（如 "U42" / "P7"）：按 (type, number) 查找
 * 返回完整套卷行；找不到返回 null。
 */
export async function resolvePaperId(
  paperId: string,
): Promise<PaperRow | null> {
  const db = getDb();
  if (isUuid(paperId) || /^\d+$/.test(paperId)) {
    const rows = await db.select().from(problems).where(
      eq(problems.id, paperId),
    ).limit(1);
    return rows[0] ?? null;
  }
  const match = /^([UP])(\d+)$/.exec(paperId);
  if (!match) return null;
  const [, type, number] = match;
  const rows = await db.select().from(problems).where(
    eq(problems.number, Number(number)),
  );
  return rows.find((row) => row.type === type) ?? null;
}

/** 解析套卷引用的规范 UUID（display_id → 真实 id）。 */
export async function resolvePaperIdToUuid(paperId: string): Promise<string> {
  const paper = await getPaperOrThrow(paperId);
  return paper.id;
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
  // P 型：仅实时 RBAC 的 problem:write_any 可管理（含查看答案）。
  // NOJ-008：JWT 中的静态 role 不得短路 RBAC。
  if (paper.type === "P") {
    if (c) {
      try {
        await assertPermission(c, "problem:write_any");
        return true;
      } catch {
        return false;
      }
    }
    return userRole === "admin";
  }
  // U 型：owner 或实时 RBAC admin 权限
  if (paper.owner_id === (c?.var.userId ?? userId)) return true;
  if (c) {
    try {
      await assertPermission(c, "problem:write_any");
      return true;
    } catch {
      return false;
    }
  }
  return userRole === "admin";
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
 * 小题快照 → 响应形态。
 *
 * 现有 API 的 `id` 返回**版本内的稳定 key**（Handbook §6.4）：同一小题在
 * V1/V2 上标识一致，历史答案可按 key 匹配。
 */
export function serializeQuestion(
  paperId: string,
  question: ObjectiveQuestionSnapshot,
  includeAnswer: boolean,
): ObjectiveQuestionResponse {
  const base: ObjectiveQuestionResponse = {
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
    base.answer = question.answer;
    base.explanation = question.explanation;
  }
  return base;
}

/**
 * 读取套卷小题：编辑者读草稿（含答案），其他人读**默认作答版本**快照。
 *
 * 已发布内容以版本快照为准（作答与历史查看不随草稿变化）；未发布套卷对
 * 非编辑者按 404 处理，与题目详情口径一致。
 *
 * @throws {NotFoundError} 套卷不存在或尚未发布（非编辑者）
 */
export async function listPaperQuestions(
  paperId: string,
  includeAnswer: boolean,
): Promise<ObjectiveQuestionResponse[]> {
  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  if (includeAnswer) {
    const questions = await listDraftQuestions(paper.id);
    return questions.map((question) =>
      serializeQuestion(paper.id, question, true)
    );
  }
  const version = await resolveProblemAnswerVersion(paper.id, paper);
  if (!version) throw new NotFoundError("题目不存在");
  const questions = await listVersionQuestions(version.version_id);
  return questions.map((question) =>
    serializeQuestion(paper.id, question, false)
  );
}

/**
 * 获取套卷小题列表（带统一访问判定）。
 *
 * 供 catalog 路由在 `?contest_id=` 场景下使用：竞赛上下文由 contest 域
 * `verifyContestAccess` 校验后传入 `resolveProblemAccess`，避免 catalog 域
 * 反向依赖 contest 域（域边界约束）。
 */
export async function listPaperQuestionsWithAccess(
  paperId: string,
  options: {
    viewerId: string | null;
    isAdmin: boolean;
    contestId?: string | null;
    userId?: string;
    userRole?: string;
    c?: Context;
  },
): Promise<ObjectiveQuestionResponse[]> {
  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);

  const contestAccess = options.contestId
    ? await verifyContestAccess(options.viewerId, options.contestId, paper.id)
    : null;
  const { result: access } = await evaluateProblemAccess(paper, {
    viewerId: options.viewerId,
    isAdmin: options.isAdmin,
    contestAccess,
  });
  if (!access.allowed) {
    throw new NotFoundError("题目不存在");
  }

  const includeAnswer = await isPaperOwnerOrAdmin(
    paper,
    options.userId,
    options.userRole,
    options.c,
  );
  return listPaperQuestions(paper.id, includeAnswer);
}
