/**
 * Problems CRUD：createProblem / updateProblem / deleteProblem（PR 拆分 PR-3）。
 *
 * 设计要点：
 * - createProblem 中 MAX+1 重试循环保留原行为不动（已有并发场景验证）
 * - updateProblem 防御性忽略 type / number 字段（spec 承诺不可变）
 * - deleteProblem 手动清理 submissions / evaluation_results（FK 无 CASCADE）
 *
 * 依赖：
 * - validateRuntimeConfig / types.ts：DTO 与 runtime 校验
 * - syncProblemCategories / problems-categories.ts：分类关联维护
 * - getProblem / problems-list.ts：回读完整结果（避免与上面产生 init 顺序循环）
 *   —— getProblem 是函数级引用，运行时才解析，无循环问题
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { evaluationResults, problems, submissions } from "../db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { logger } from "../lib/logging.ts";
import { validateJudgeImageWithKind } from "./judge-images.ts";
import { logAudit } from "./audit-log.ts";
import {
  type CreateProblemInput,
  DIFFICULTIES,
  isValidDifficulty,
  isValidProblemType,
  type ProblemResponseWithCategories,
  type UpdateProblemInput,
} from "../types/problems.ts";
import { validateRuntimeConfig } from "./problems-types.ts";
import { syncProblemCategories } from "./problems-categories.ts";
import { getProblem } from "./problems-list.ts";

/**
 * 创建题目。
 *
 * admin 可创建任意 type，普通用户仅限 U 型。
 * 自动设 owner_id 为当前用户，自动分配 U 型 number。
 *
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 普通用户尝试创建 P 型题目
 */
export async function createProblem(
  input: CreateProblemInput,
  userId?: string,
  userRole?: string,
): Promise<ProblemResponseWithCategories> {
  const db = getDb();

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  // 校验 runtime_config（所有题目统一使用双容器模式）
  if (input.runtime_config !== undefined && input.runtime_config !== null) {
    validateRuntimeConfig(input.runtime_config);
    try {
      await validateJudgeImageWithKind(
        input.runtime_config.evaluator.image,
        "evaluator",
      );
      await validateJudgeImageWithKind(
        input.runtime_config.solution.image,
        "solution",
      );
    } catch (err) {
      logger.error("createProblem: runtime_config 镜像校验失败", { err });
      throw err;
    }
  } else {
    logger.error("createProblem: runtime_config 缺失", {
      input: JSON.stringify(input),
    });
    throw new BadRequestError("runtime_config 是必填字段");
  }

  // 题目主键统一由服务端生成 UUID，避免客户端注入字符串 id
  // 影响 display_id 双索引路由解析
  const id = crypto.randomUUID();

  // 确定题目类型（默认 U）
  const rawType = input.type?.toUpperCase() ?? "U";
  if (!isValidProblemType(rawType)) {
    throw new BadRequestError(`非法题目类型：${input.type}，仅允许 U/P`);
  }
  const type = rawType;

  // 权限检查：普通用户只能创建 U 型
  if (type === "P" && userRole !== "admin") {
    throw new ForbiddenError("仅管理员可创建管理题");
  }

  // 确定所有者
  const ownerId = userId ?? "0";

  // 确定题号（同一 type 内自增，并发冲突时重试）
  // 仅 admin 可指定 number；普通用户强制 MAX+1
  const adminProvidedNumber = input.number !== undefined;
  if (adminProvidedNumber && userRole !== "admin") {
    throw new ForbiddenError("仅管理员可指定题号");
  }
  let number = input.number;
  // 确定题号 + 插入（MAX+1 并发冲突时最多重试 3 次）
  const MAX_RETRIES = 3;
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (number === undefined) {
      const result = await db
        .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
        .from(problems)
        .where(eq(problems.type, type));
      number = (result[0]?.max ?? 0) + 1;
    }

    try {
      await db.insert(problems).values({
        id,
        title: input.title,
        description: input.description,
        difficulty: input.difficulty ?? "medium",
        support_package_storage_url: input.support_package_storage_url ?? null,
        runtime_config: input.runtime_config ?? null,
        number,
        owner_id: ownerId,
        type,
        created_at: now,
        updated_at: now,
      });
      break; // 插入成功，退出重试循环
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      // PostgreSQL UNIQUE 约束冲突错误码 23505
      // postgres.js 在 err.code，PGlite 在 err.cause.code
      const pgCode = err && typeof err === "object"
        ? (err as Record<string, unknown>).code ||
          ((err as Record<string, unknown>).cause as Record<string, unknown>)
            ?.code
        : undefined;
      if (pgCode === "23505") {
        // 管理员指定 number 冲突 → 直接报错，不自动重试
        if (adminProvidedNumber) throw err;
        number = undefined; // 重置 number，下一轮重新 MAX+1
        continue;
      }
      throw err; // 非唯一冲突，直接抛出
    }
  }

  // 处理分类关联
  if (input.category_ids && input.category_ids.length > 0) {
    await syncProblemCategories(id, input.category_ids);
  }

  return getProblem(id);
}

/**
 * 全量更新题目。
 *
 * 权限规则：
 * - admin 可更新任意题目
 * - U 型：owner 可更新
 * - P 型：仅 admin 可更新
 * - 禁止修改 type 和 number 字段
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 权限不足
 */
export async function updateProblem(
  id: string,
  input: UpdateProblemInput,
  userId?: string,
  userRole?: string,
): Promise<ProblemResponseWithCategories> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];

  // 权限检查
  if (userRole !== "admin") {
    if (problem.type === "P") {
      throw new ForbiddenError("仅管理员可编辑管理题");
    }
    // U 型：仅所有者可编辑
    if (problem.owner_id !== userId) {
      throw new ForbiddenError("无权编辑此题目");
    }
  }

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  // 校验 runtime_config
  //   undefined → 不变；null → 拒绝（runtime_config 是必填字段）；object → 校验并写入
  if (input.runtime_config !== undefined) {
    if (input.runtime_config === null) {
      throw new BadRequestError("runtime_config 是必填字段，不可清空");
    }
    validateRuntimeConfig(input.runtime_config);
    await validateJudgeImageWithKind(
      input.runtime_config.evaluator.image,
      "evaluator",
    );
    await validateJudgeImageWithKind(
      input.runtime_config.solution.image,
      "solution",
    );
  }

  // 防御性忽略 type 和 number（spec 承诺这两个字段不可变更）
  delete (input as Record<string, unknown>)["type"];
  delete (input as Record<string, unknown>)["number"];

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.difficulty !== undefined) updates.difficulty = input.difficulty;
  if (input.support_package_storage_url !== undefined) {
    updates.support_package_storage_url = input.support_package_storage_url;
  }
  if (input.runtime_config !== undefined) {
    updates.runtime_config = input.runtime_config;
  }
  updates.updated_at = new Date().toISOString();

  await db.update(problems).set(updates).where(eq(problems.id, id));

  // 处理分类关联
  if (input.category_ids !== undefined) {
    await syncProblemCategories(id, input.category_ids);
  }

  // 审计日志：runtime_config 变更
  if (input.runtime_config !== undefined) {
    const oldHas = problem.runtime_config !== null;
    const newHas = input.runtime_config !== null;
    if (
      oldHas !== newHas ||
      JSON.stringify(problem.runtime_config) !==
        JSON.stringify(input.runtime_config)
    ) {
      await logAudit(
        "problems.runtime_config_changed",
        {
          action: "problems.runtime_config_changed",
          title: problem.title,
          display_id: `${problem.type}${problem.number}`,
          old_has_runtime_config: oldHas,
          new_has_runtime_config: newHas,
        },
        { type: "problem", id },
      );
    }
  }

  return getProblem(id);
}

/**
 * 删除题目。
 *
 * 权限规则：
 * - admin 可删除任意题目
 * - U 型：owner 可删除
 * - P 型：仅 admin 可删除
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 权限不足
 */
export async function deleteProblem(
  id: string,
  userId?: string,
  userRole?: string,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];

  // 权限检查
  if (userRole !== "admin") {
    if (problem.type === "P") {
      throw new ForbiddenError("仅管理员可删除管理题");
    }
    if (problem.owner_id !== userId) {
      throw new ForbiddenError("无权删除此题目");
    }
  }

  // 清理支持包（通过 StorageProvider，幂等）
  const storageUrl = problem.support_package_storage_url;
  if (storageUrl) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(storageUrl);
    } catch (err) {
      logger.error("清理支持包失败", { storage_url: storageUrl, err });
    }
  }

  // 清理关联提交（submissions 无 ON DELETE CASCADE，需手动清理）
  await db.delete(evaluationResults)
    .where(
      inArray(
        evaluationResults.submission_id,
        db.select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.problem_id, id)),
      ),
    );
  await db.delete(submissions).where(eq(submissions.problem_id, id));

  // 级联删除（problems_categories 的 ON DELETE CASCADE 会自动清理关联）
  await db.delete(problems).where(eq(problems.id, id));

  // 审计日志：删除成功后才记录（display_id 由 type+number 派生）
  await logAudit(
    "problems.delete",
    {
      action: "problems.delete",
      title: problem.title,
      display_id: `${problem.type}${problem.number}`,
    },
    { type: "problem", id },
  );
}
