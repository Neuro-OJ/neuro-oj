/**
 * 统一题目包导入服务（problem-bundle-import）。
 *
 * 编排流程：解析 zip → 校验 manifest → 剥离元数据重建评测包 →
 * storage 注册 → 落库元数据（更新复用 updateProblem；创建复用 createProblem 校验语义）。
 *
 * 语义：
 * - manifest 不含 id：题目主键一律由服务端生成 UUID。
 * - manifest.number 仅 admin 生效，作为幂等键：按 (type, number) 匹配既有题目
 *   → 更新（元数据 + 替换评测包）；未命中 → 创建；(type, number) 由 DB 联合
 *   唯一约束保证唯一，缺省时自动分配 type 内 MAX+1。
 * - 非 admin 提供 manifest.number 直接拒绝（400）：普通用户导入只能创建新题
 *   （number 自动分配），避免"上传以为更新、实则新建"的误导。
 * - 题面唯一事实来源是数据库：statement.md 与 manifest.description 仅用于
 *   本次导入写入，评测包中不含这两个元数据文件。
 */

import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  objectiveQuestions,
  problems,
} from "./../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { logger } from "./../../../../shared/base/logging.ts";
import { checkPermission } from "../../../../lib/permissions.ts";
import { getStorageProvider } from "../../../../lib/storage/mod.ts";
import {
  parseBundleZip,
  stripMetadataEntries,
} from "../../../../lib/bundle-parser.ts";
import {
  isValidProblemBundleName,
  type ProblemBundleManifest,
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../../../types/problem-bundle.ts";
import type { ProblemResponseWithTags } from "../../../../types/problems.ts";
import { type CreateQuestionInput } from "../../../../types/objective.ts";
import { updateProblem } from "./problems-crud.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import { syncProblemTags, validateProblemTagIds } from "./problems-tags.ts";
import { judgeOptions } from "../../../objective/index.ts";
import { getProblem } from "./problems-list.ts";
import { getTagIdsByNames, listTags } from "../tags.ts";
import { logAudit } from "../../../system/index.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../support-package.ts";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";

/** 导入执行者（CLI 场景无 Hono Context）。 */
export interface BundleImportActor {
  userId?: string;
  userRole?: string;
}

/**
 * 构建评测包存储键（与 support-package.ts 的 `packages/<problem_id>.zip` 约定一致）。
 */
function buildPackageKey(problemId: string): string {
  return `packages/${problemId}.zip`;
}

/**
 * 按标签名解析为标签 id 列表（issue #223：manifest.tags 取代 categories）。
 *
 * 与既有导入语义一致：不存在的标签名被忽略并记录 warning。
 */
async function resolveTagIds(
  names: string[] | undefined,
): Promise<string[]> {
  if (!names || names.length === 0) return [];

  const uniqueNames = [...new Set(names)];
  const ids = await getTagIdsByNames(uniqueNames);
  if (ids.length !== uniqueNames.length) {
    const all = await listTags();
    const known = new Set(all.map((t) => t.name));
    for (const name of uniqueNames) {
      if (!known.has(name)) {
        logger.warn(`题目导入：标签 "${name}" 不存在，已忽略`);
      }
    }
  }
  return ids;
}

/**
 * 判断执行者是否 admin。
 *
 * 有 Hono Context 时走 RBAC 权限检查（`problem:write_any` 为 admin 级权限），
 * 否则退化为 userRole 判断（CLI 场景）。
 */
function isAdminActor(
  actor: BundleImportActor,
  c?: Context,
): boolean | Promise<boolean> {
  if (c) {
    return checkPermission(c, "problem:write_any");
  }
  return actor.userRole === "admin";
}

/**
 * 统一题目包导入入口。
 *
 * @param file 上传的 zip（导入载体，根级含 problem.json/evaluate.py）
 * @param actor 执行者（userId/userRole）
 * @param c 可选 Hono Context（HTTP 路由场景传入；CLI 场景为 undefined）
 * @returns 导入/更新后的题目响应
 * @throws {ValidationError} 非 zip / 超大小
 * @throws {BadRequestError} 格式/校验失败
 * @throws {ForbiddenError} 权限不足（由 createProblem/updateProblem 抛出）
 */
export async function importProblemBundle(
  file: { name: string; data: Uint8Array },
  actor: BundleImportActor,
  c?: Context,
): Promise<ProblemResponseWithTags> {
  // 1. 基础校验：后缀 + 大小（与 support-package 上传约定一致）
  if (!isValidProblemBundleName(file.name)) {
    throw new ValidationError("仅支持 .zip 格式文件");
  }
  if (file.data.length > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new ValidationError(
      `导入包大小超过限制（最大 ${
        (MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024).toFixed(0)
      }MB）`,
    );
  }

  // 2. 解析 + 校验（含 ZIP 安全与 manifest 结构校验、command 默认注入）
  const parsed = parseBundleZip(file.data);
  const manifest = validateBundleManifest(parsed.manifest);

  // 3. 题面：statement.md 优先，manifest.description 兜底，二者皆缺 → 400
  const description = parsed.statement ?? manifest.description;
  if (!description || !description.trim()) {
    throw new BadRequestError(
      "缺少题面：zip 需包含 statement.md 或 manifest.description",
    );
  }

  // 4. 权限与 number 语义：number 是 admin 幂等键——admin 提供时按 (type, number)
  //    匹配既有题目 → 更新、未命中 → 新建；非 admin 提供 number 直接拒绝（400），
  //    普通用户导入仅走创建路径（number 自动分配）。
  const admin = await isAdminActor(actor, c);
  if (!admin && manifest.number !== undefined) {
    throw new BadRequestError(
      "仅管理员可指定 number（按 (type, number) 幂等更新既有题目）；普通用户导入时题号由系统自动分配",
    );
  }
  const number = admin ? manifest.number : undefined;

  // 4.5 客观题套卷：走独立导入路径（无评测包，事务性创建/更新 + 全量替换小题）
  if (manifest.is_objective) {
    const questions = validateObjectiveQuestions(parsed.questions);
    return importObjectivePaper(
      manifest,
      description,
      questions,
      number,
      actor,
      c,
    );
  }

  // 5. 剥离元数据，重建纯净评测包
  const strippedZip = stripMetadataEntries(file.data);
  const storage = await getStorageProvider();

  // 6. 分发：manifest.number 提供时按 (type, number) 业务键匹配（命中 → 更新；
  //    未命中 → 创建）；未提供 → 创建（number 自动分配）。id 一律由服务端生成，
  //    (type, number) 由 DB 联合唯一约束保证唯一（problems_type_number_unique）。
  let result: ProblemResponseWithTags;
  if (number !== undefined) {
    const type = manifest.type ?? "U";
    const db = getDb();
    const byNumber = await db
      .select({
        id: problems.id,
        storageUrl: problems.support_package_storage_url,
      })
      .from(problems)
      .where(and(eq(problems.type, type), eq(problems.number, number)))
      .limit(1);
    if (byNumber.length > 0) {
      result = await updateExisting(
        byNumber[0].id,
        byNumber[0].storageUrl,
        manifest,
        description,
        actor,
        c,
        storage,
        strippedZip,
      );
    } else {
      result = await createViaCrud(
        manifest,
        description,
        number,
        actor,
        c,
        storage,
        strippedZip,
      );
    }
  } else {
    // 创建路径（number 自动分配）
    result = await createViaCrud(
      manifest,
      description,
      number,
      actor,
      c,
      storage,
      strippedZip,
    );
  }

  // 7. 审计日志（仅 HTTP 路由场景；CLI 无 RequestContext，跳过）
  if (c) {
    await logAudit(
      "problems.imported",
      {
        action: "problems.imported",
        title: result.title,
        display_id: result.display_id,
        imported_with_id: false,
      },
      { type: "problem", id: result.id },
    );
  }

  return result;
}

/**
 * 更新路径：替换评测包（尽力删除旧对象，失败不阻塞）+ 更新元数据。
 */
async function updateExisting(
  problemId: string,
  oldStorageUrl: string | null,
  manifest: ProblemBundleManifest,
  description: string,
  actor: BundleImportActor,
  c: Context | undefined,
  storage: Awaited<ReturnType<typeof getStorageProvider>>,
  strippedZip: Uint8Array,
): Promise<ProblemResponseWithTags> {
  // issue #207：先于 storage 操作执行敏感字段权限 + 资源上限校验——
  // 若在 storage 操作之后才失败（updateProblem 内部），旧评测包已被删除、
  // 新包已上传而 DB 未更新，造成评测包指向不存在的对象（评审 I4）。
  await assertSensitiveFieldPermissions(
    c,
    actor.userId,
    actor.userRole,
    manifest.runtime_config!,
  );
  enforceResourceLimits(manifest.runtime_config!);

  if (oldStorageUrl) {
    try {
      await storage.delete(oldStorageUrl);
    } catch (err) {
      logger.warn("题目导入：删除旧评测包失败", { problem_id: problemId, err });
    }
  }
  const storageUrl = await storage.put(
    buildPackageKey(problemId),
    strippedZip,
    "application/zip",
  );
  return updateProblem(
    problemId,
    {
      title: manifest.title,
      description,
      difficulty: manifest.difficulty,
      runtime_config: manifest.runtime_config!,
      submission_mode: manifest.submission_mode,
      artifact_max_size_mb: manifest.artifact_max_size_mb,
      llm: manifest.llm,
      support_package_storage_url: storageUrl,
      tag_ids: await resolveTagIds(manifest.tags),
    },
    actor.userId,
    actor.userRole,
    c,
    true, // import-bundle 是服务端生成 storage URL 的受控流程
  );
}

/**
 * 客观题套卷导入路径。
 *
 * 与编程题导入的差异：
 * - 不剥离/上传评测包，support_package_storage_url 保持 NULL；
 * - 套卷行 + 小题全量替换在同一 DB 事务内完成；
 * - 不自动重测历史提交。
 */
async function importObjectivePaper(
  manifest: ProblemBundleManifest,
  description: string,
  questions: CreateQuestionInput[],
  number: number | undefined,
  actor: BundleImportActor,
  c?: Context,
): Promise<ProblemResponseWithTags> {
  const type = manifest.type ?? "U";

  // number 权限（与编程题一致，防御性重复校验）
  if (!(await isAdminActor(actor, c)) && number !== undefined) {
    throw new BadRequestError(
      "仅管理员可指定 number（按 (type, number) 幂等更新既有题目）；普通用户导入时题号由系统自动分配",
    );
  }

  // 类型权限（与 createViaCrud 一致）
  if (type === "P") {
    if (!(await isAdminActor(actor, c))) {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else if (c) {
    const canCreate = await checkPermission(c, "problem:create");
    if (!canCreate) {
      throw new ForbiddenError("无权创建题目");
    }
  } else if (actor.userRole !== "admin" && actor.userRole !== "user") {
    throw new ForbiddenError("无权创建题目");
  }

  const db = getDb();
  const tagIds = await resolveTagIds(manifest.tags);
  // 半写入防护：客观题禁止算法标签在写库前校验
  if (tagIds.length > 0) {
    await validateProblemTagIds(tagIds, true);
  }

  const now = new Date().toISOString();
  let oldStorageUrl: string | null = null;

  const outcome = await db.transaction(async (tx) => {
    let existingId: string | null = null;
    if (number !== undefined) {
      const rows = await tx
        .select({
          id: problems.id,
          storageUrl: problems.support_package_storage_url,
        })
        .from(problems)
        .where(and(eq(problems.type, type), eq(problems.number, number)))
        .limit(1);
      if (rows.length > 0) {
        existingId = rows[0].id;
        oldStorageUrl = rows[0].storageUrl;
      }
    }

    let problemId: string;
    if (existingId) {
      problemId = existingId;
      await tx.update(problems).set({
        title: manifest.title,
        description,
        difficulty: manifest.difficulty ?? "medium",
        is_objective: true,
        runtime_config: null,
        support_package_storage_url: null,
        submission_mode: "code",
        artifact_max_size_mb: null,
        llm_config: null,
        updated_at: now,
      }).where(eq(problems.id, problemId));
    } else {
      problemId = crypto.randomUUID();
      let finalNumber = number;
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (finalNumber === undefined) {
          const [row] = await tx
            .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
            .from(problems)
            .where(eq(problems.type, type));
          finalNumber = Number(row?.max ?? 0) + 1;
        }
        try {
          await tx.insert(problems).values({
            id: problemId,
            title: manifest.title,
            description,
            difficulty: manifest.difficulty ?? "medium",
            runtime_config: null,
            is_objective: true,
            number: finalNumber,
            owner_id: actor.userId ?? ROOT_USER_ID,
            type,
            created_at: now,
            updated_at: now,
          });
          break;
        } catch (err) {
          if (attempt === MAX_RETRIES - 1) throw err;
          const pgCode = err && typeof err === "object"
            ? (err as Record<string, unknown>).code ||
              ((err as Record<string, unknown>).cause as Record<
                string,
                unknown
              >)
                ?.code
            : undefined;
          if (pgCode === "23505") {
            if (number !== undefined) throw err;
            finalNumber = undefined;
            continue;
          }
          throw err;
        }
      }
    }

    // 全量替换小题
    await tx.delete(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, problemId),
    );
    for (const q of questions) {
      const options = q.type === "judge" ? judgeOptions() : (q.options ?? []);
      await tx.insert(objectiveQuestions).values({
        id: crypto.randomUUID(),
        paper_id: problemId,
        sort_order: q.sort_order ?? 0,
        type: q.type,
        prompt: q.prompt,
        options,
        answer: q.answer,
        explanation: q.explanation ?? "",
        created_at: now,
        updated_at: now,
      });
    }

    return { problemId };
  });

  // 标签同步（独立事务，与既有导入一致）
  if (tagIds.length > 0) {
    await syncProblemTags(outcome.problemId, tagIds, true);
  }

  // 若从编程题转换为客观题，尽力清理旧评测包（失败不阻塞）
  if (oldStorageUrl) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(oldStorageUrl);
    } catch (err) {
      logger.warn("客观题导入：删除旧评测包失败", {
        problem_id: outcome.problemId,
        err,
      });
    }
  }

  return getProblem(outcome.problemId);
}

/**
 * 创建路径。
 *
 * 与 createProblem 对齐的校验（P 型权限、镜像白名单、number 分配）。
 * id 一律由服务端生成 UUID；(type, number) 由 DB 联合唯一约束保证唯一，
 * 并发冲突（23505）时自动分配重试。
 */
async function createViaCrud(
  manifest: ProblemBundleManifest,
  description: string,
  number: number | undefined,
  actor: BundleImportActor,
  c: Context | undefined,
  storage: Awaited<ReturnType<typeof getStorageProvider>>,
  strippedZip: Uint8Array,
): Promise<ProblemResponseWithTags> {
  const type = manifest.type ?? "U";

  // NOJ-102：创建权限按类型强制执行（与 createProblem 一致）。
  if (type === "P") {
    if (!(await isAdminActor(actor, c))) {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else if (c) {
    const canCreate = await checkPermission(c, "problem:create");
    if (!canCreate) {
      throw new ForbiddenError("无权创建题目");
    }
  } else if (actor.userRole !== "admin" && actor.userRole !== "user") {
    throw new ForbiddenError("无权创建题目");
  }

  // 镜像白名单校验（与 createProblem 一致）
  await validateJudgeImageWithKind(
    manifest.runtime_config!.evaluator.image,
    "evaluator",
  );
  await validateJudgeImageWithKind(
    manifest.runtime_config!.solution.image,
    "solution",
  );

  // evaluator 联网权限与题目创建权限一致：普通用户导入创建 U 型题可开网；
  // P 型由上方类型检查保证仅 admin。安全提醒：联网 + 可控 evaluator.command
  // = 联网容器任意命令执行，题目包 manifest.runtime_config 由上传者完全可控。
  // issue #207：与 CRUD 创建路径一致的敏感字段权限检查 + 资源上限校验
  await assertSensitiveFieldPermissions(
    c,
    actor.userId,
    actor.userRole,
    manifest.runtime_config!,
  );
  enforceResourceLimits(manifest.runtime_config!);

  const db = getDb();
  const tagIds = await resolveTagIds(manifest.tags);

  // number：admin 指定或 type 内 MAX+1（并发冲突 23505 时最多重试 3 次，
  // 与 createProblem 的分配语义一致）
  const MAX_RETRIES = 3;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let finalNumber = number;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (finalNumber === undefined) {
      const [row] = await db
        .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
        .from(problems)
        .where(eq(problems.type, type));
      finalNumber = Number(row?.max ?? 0) + 1;
    }

    try {
      await db.insert(problems).values({
        id,
        title: manifest.title,
        description,
        difficulty: manifest.difficulty ?? "medium",
        runtime_config: manifest.runtime_config!,
        submission_mode: manifest.submission_mode ?? "code",
        artifact_max_size_mb: manifest.artifact_max_size_mb ?? null,
        llm_config: manifest.llm ?? null,
        number: finalNumber,
        owner_id: actor.userId ?? ROOT_USER_ID,
        type,
        created_at: now,
        updated_at: now,
      });
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      // PG 唯一约束冲突（type+number）
      const pgCode = err && typeof err === "object"
        ? (err as Record<string, unknown>).code ||
          ((err as Record<string, unknown>).cause as Record<string, unknown>)
            ?.code
        : undefined;
      if (pgCode === "23505") {
        // admin 显式指定 number 冲突 → 直接报错
        if (number !== undefined) throw err;
        finalNumber = undefined;
        continue;
      }
      throw err;
    }
  }

  if (tagIds.length > 0) {
    await syncProblemTags(id, tagIds);
  }

  // 注册评测包并回填
  const storageUrl = await storage.put(
    buildPackageKey(id),
    strippedZip,
    "application/zip",
  );
  await db
    .update(problems)
    .set({ support_package_storage_url: storageUrl, updated_at: now })
    .where(eq(problems.id, id));

  return getProblem(id);
}

/**
 * 供 CLI 使用的题面兜底：按 id 查询题目（无 id 时抛 NotFoundError）。
 * 仅导出给 scripts/noj.ts 复用，避免重复查询逻辑。
 */
export async function requireProblemById(id: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: problems.id })
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError(`题目不存在：${id}`);
  }
}

export { getProblem };
