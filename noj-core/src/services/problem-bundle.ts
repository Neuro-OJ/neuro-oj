/**
 * 统一题目包导入服务（problem-bundle-import）。
 *
 * 编排流程：解析 zip → 校验 manifest → 剥离元数据重建评测包 →
 * storage 注册 → 落库元数据（更新复用 updateProblem；创建复用 createProblem 校验语义）。
 *
 * 语义：
 * - manifest.id 仅 admin 生效：匹配顺序 主键 id → (type, number) 业务键 → 以 manifest.id 创建；
 *   非 admin 提供 id/number → 忽略（创建路径）。
 * - 题面唯一事实来源是数据库：statement.md 与 manifest.description 仅用于
 *   本次导入写入，评测包中不含这两个元数据文件。
 */

import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { logger } from "../lib/logging.ts";
import { checkPermission } from "../lib/permissions.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { parseBundleZip, stripMetadataEntries } from "../lib/bundle-parser.ts";
import {
  isValidProblemBundleName,
  type ProblemBundleManifest,
  validateBundleManifest,
} from "../types/problem-bundle.ts";
import type { ProblemResponseWithCategories } from "../types/problems.ts";
import { updateProblem } from "./problems-crud.ts";
import { validateJudgeImageWithKind } from "./judge-images.ts";
import { syncProblemCategories } from "./problems-categories.ts";
import { getProblem } from "./problems-list.ts";
import { type CategoryTreeNode, listCategories } from "./categories.ts";
import { logAudit } from "./audit-log.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "./support-package.ts";

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
 * 按分类名解析为分类 id 列表。
 *
 * 与既有导入语义一致：不存在的分类名被忽略并记录 warning。
 * 注：listCategories 返回树形，这里扁平遍历收集 name → id。
 */
async function resolveCategoryIds(
  names: string[] | undefined,
): Promise<string[]> {
  if (!names || names.length === 0) return [];
  const tree = await listCategories();
  const nameToId = new Map<string, string>();
  const walk = (nodes: CategoryTreeNode[]): void => {
    for (const node of nodes) {
      nameToId.set(node.name, node.id);
      walk(node.children);
    }
  };
  walk(tree);

  const ids: string[] = [];
  for (const name of names) {
    const id = nameToId.get(name);
    if (id) {
      ids.push(id);
    } else {
      logger.warn(`题目导入：分类 "${name}" 不存在，已忽略`);
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
async function isAdminActor(
  actor: BundleImportActor,
  c?: Context,
): Promise<boolean> {
  if (c) {
    return await checkPermission(c, "problem:write_any");
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
): Promise<ProblemResponseWithCategories> {
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

  // 4. 权限与 id 语义：仅 admin 的 id/number 生效；非 admin 忽略（走创建路径）
  const admin = await isAdminActor(actor, c);
  const upsertId = admin && manifest.id ? manifest.id : undefined;
  const number = admin ? manifest.number : undefined;

  // 5. 剥离元数据，重建纯净评测包
  const strippedZip = stripMetadataEntries(file.data);
  const storage = await getStorageProvider();

  // 6. 分发：更新（id 或 (type, number) 业务键匹配既有题目）或创建
  let result: ProblemResponseWithCategories;
  if (upsertId) {
    const db = getDb();
    // 匹配顺序：主键 id 优先；其次 (type, number) 业务键（兼容历史 UUID 主键数据）
    const existing = await db
      .select({ storageUrl: problems.support_package_storage_url })
      .from(problems)
      .where(eq(problems.id, upsertId))
      .limit(1);

    if (existing.length > 0) {
      result = await updateExisting(
        upsertId,
        existing[0].storageUrl,
        manifest,
        description,
        actor,
        c,
        storage,
        strippedZip,
      );
    } else if (number !== undefined) {
      // id 未命中，尝试按 (type, number) 匹配（幂等导入的关键兜底）
      const type = manifest.type ?? "U";
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
        // id 声明了但题目不存在 → 以 manifest.id 为主键创建（保证后续幂等）
        result = await createViaCrud(
          manifest,
          description,
          number,
          actor,
          c,
          storage,
          strippedZip,
          upsertId,
        );
      }
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
    // 创建路径
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
        imported_with_id: Boolean(upsertId),
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
): Promise<ProblemResponseWithCategories> {
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
  return await updateProblem(
    problemId,
    {
      title: manifest.title,
      description,
      difficulty: manifest.difficulty,
      runtime_config: manifest.runtime_config,
      support_package_storage_url: storageUrl,
      category_ids: await resolveCategoryIds(manifest.categories),
    },
    actor.userId,
    actor.userRole,
    c,
  );
}

/**
 * 创建路径。
 *
 * 与 createProblem 对齐的校验（P 型权限、镜像白名单、number 分配），
 * 但支持 `preferredId`（仅 admin 的 manifest.id）：以固定主键创建，
 * 保证重复导入幂等（下次按 id 命中更新路径）。
 */
async function createViaCrud(
  manifest: ProblemBundleManifest,
  description: string,
  number: number | undefined,
  actor: BundleImportActor,
  c: Context | undefined,
  storage: Awaited<ReturnType<typeof getStorageProvider>>,
  strippedZip: Uint8Array,
  preferredId?: string,
): Promise<ProblemResponseWithCategories> {
  const type = manifest.type ?? "U";

  // P 型仅 admin（与 createProblem 权限一致）
  if (type === "P" && !(await isAdminActor(actor, c))) {
    throw new ForbiddenError("仅管理员可创建管理题");
  }

  // 镜像白名单校验（与 createProblem 一致）
  await validateJudgeImageWithKind(
    manifest.runtime_config.evaluator.image,
    "evaluator",
  );
  await validateJudgeImageWithKind(
    manifest.runtime_config.solution.image,
    "solution",
  );

  const db = getDb();
  const categoryIds = await resolveCategoryIds(manifest.categories);

  // number：admin 指定或 type 内 MAX+1
  let finalNumber = number;
  if (finalNumber === undefined) {
    const [row] = await db
      .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
      .from(problems)
      .where(eq(problems.type, type));
    finalNumber = Number(row?.max ?? 0) + 1;
  }

  const id = preferredId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: manifest.title,
    description,
    difficulty: manifest.difficulty ?? "medium",
    runtime_config: manifest.runtime_config,
    number: finalNumber,
    owner_id: actor.userId ?? "0",
    type,
    created_at: now,
    updated_at: now,
  });

  if (categoryIds.length > 0) {
    await syncProblemCategories(id, categoryIds);
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
