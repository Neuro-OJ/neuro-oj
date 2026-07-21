/**
 * Problems 导入导出（issue #28，PR 拆分 PR-3）。
 *
 * 公开 API：
 * - buildExportPayload：按 ids / type 导出元数据 + 分类 + samples
 * - importProblems：批量导入（create / overwrite / skip 三策略）
 *
 * 内部辅助：
 * - assertStorageUrlFormat：URL 协议前缀白名单校验
 * - parseImportPayload：导入文件版本/结构守卫
 * - buildCategoryLookup：分类 name → id 一次性查询
 * - importOne：单条 import 逻辑（按策略分发 create/update/skip/failed）
 *
 * 依赖：
 * - problems-types.ts：validateRuntimeConfig（createOne 路径已透传 createProblem）
 * - problems-list.ts：attachCategories（导出时注入分类）
 * - problems-categories.ts：syncProblemCategories（overwrite 路径）
 * - problems-crud.ts：createProblem（导入新条目时复用完整权限/重试逻辑）
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import { BadRequestError } from "../lib/errors.ts";
import { extractSamples } from "../lib/samples.ts";
import { listCategories } from "./categories.ts";
import {
  EXPORT_VERSION,
  type ExportPayload,
  type ExportProblem,
  type ExportQuery,
  type ImportItemResult,
  type ImportReport,
  type ImportStrategy,
  isValidDifficulty,
  isValidProblemType,
  type RuntimeConfig,
} from "../types/problems.ts";
import { attachCategories } from "./problems-list.ts";
import { syncProblemCategories } from "./problems-categories.ts";
import { createProblem } from "./problems-crud.ts";

// ─── 题目导入导出（issue #28）─────────────────────────────────

/**
 * 校验 support_package_storage_url 格式合法。
 *
 * 走法 A 不做可达性检查——导出是元数据操作，不应因为临时 S3 故障
 * 就让导出失败。如果 URL 真正坏掉，导入后 judge 端评测会自然报错。
 * 这里只拦截明显错误的协议前缀，避免 round-trip 引入脏数据。
 */
function assertStorageUrlFormat(url: string | null): void {
  if (!url) return;
  if (
    !url.startsWith("noj-storage://") &&
    !url.startsWith("noj-download://")
  ) {
    throw new BadRequestError(
      `支持包 URL 协议不受支持：${url}（仅支持 noj-storage:// 或 noj-download://）`,
    );
  }
}

/**
 * 导出题目集合为标准 JSON 结构。
 *
 * 查询模式：
 * - `ids` 优先：按指定 id 列表精确导出
 * - `type`：按题目类型批量导出（U/P 全部）
 * - 二者都未提供或都提供 → 拒绝
 *
 * 返回结构遵循 EXPORT_VERSION 约定的字段命名，round-trip 安全。
 *
 * @throws {BadRequestError} 查询参数非法 / 支持包 URL 校验失败
 */
export async function buildExportPayload(
  query: ExportQuery,
  exportedBy: string,
): Promise<ExportPayload> {
  const db = getDb();

  // 互斥校验
  const hasIds = query.ids !== undefined && query.ids.length > 0;
  const hasType = query.type !== undefined;
  if (hasIds && hasType) {
    throw new BadRequestError("ids 和 type 互斥，请二选一");
  }
  if (!hasIds && !hasType) {
    throw new BadRequestError("必须提供 ids 或 type 之一");
  }
  if (hasType && query.type !== undefined && !isValidProblemType(query.type)) {
    throw new BadRequestError(
      `非法题目类型：${query.type}，仅允许 U/P`,
    );
  }

  // 查询题目
  let rows: (typeof problems.$inferSelect)[];
  if (hasIds) {
    rows = await db
      .select()
      .from(problems)
      .where(inArray(problems.id, query.ids!));
  } else {
    rows = await db
      .select()
      .from(problems)
      .where(eq(problems.type, query.type!));
  }

  if (rows.length === 0) {
    return {
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      exported_by: exportedBy,
      problems: [],
    };
  }

  // 注入分类信息
  const catMap = await attachCategories(rows.map((r) => r.id));

  // 校验所有 support_package URL 协议前缀合法
  for (const row of rows) {
    assertStorageUrlFormat(row.support_package_storage_url);
  }

  // 组装 ExportProblem
  const exportedProblems: ExportProblem[] = rows.map((row) => {
    const cats = catMap.get(row.id) ?? [];
    return {
      id: row.id,
      display_id: `${row.type}${row.number}`,
      type: row.type as "U" | "P",
      number: row.number,
      title: row.title,
      description: row.description,
      difficulty: row.difficulty,
      categories: cats.map((c) => ({ name: c.name, slug: c.slug })),
      support_package_storage_url: row.support_package_storage_url,
      test_cases_ref: row.support_package_storage_url,
      runtime_config: row.runtime_config as RuntimeConfig,
      samples: extractSamples(row.description),
    };
  });

  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    exported_by: exportedBy,
    problems: exportedProblems,
  };
}

// ─── 导入服务 ──────────────────────────────────────────────

/**
 * 导入 payload 类型守卫。
 * 校验 version、problems 数组、每个 ExportProblem 的基本字段。
 */
function parseImportPayload(input: unknown): ExportPayload {
  if (!input || typeof input !== "object") {
    throw new BadRequestError("导入文件必须为 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== EXPORT_VERSION) {
    throw new BadRequestError(
      `不支持的导入文件版本：${
        String(obj.version)
      }（当前仅支持 ${EXPORT_VERSION}）`,
    );
  }
  if (!Array.isArray(obj.problems)) {
    throw new BadRequestError("导入文件必须包含 problems 数组");
  }
  for (let i = 0; i < obj.problems.length; i++) {
    const p = obj.problems[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object") {
      throw new BadRequestError(`problems[${i}] 不是合法对象`);
    }
    for (
      const field of [
        "id",
        "title",
        "description",
        "type",
        "number",
      ]
    ) {
      if (!(field in p)) {
        throw new BadRequestError(
          `problems[${i}] 缺少必填字段：${field}`,
        );
      }
    }
  }
  return obj as unknown as ExportPayload;
}

/**
 * 构建分类 name → id 映射（用于按 name 解析导入题目中的分类关联）。
 *
 * 走法 A 不支持自动创建分类——不存在的分类名会被忽略（warning），
 * 由 admin 自行在导入前手动创建，避免脏数据。
 */
async function buildCategoryLookup(): Promise<Map<string, string>> {
  const tree = await listCategories();
  const map = new Map<string, string>();
  const visit = (nodes: typeof tree) => {
    for (const n of nodes) {
      map.set(n.name, n.id);
      if (n.children.length > 0) visit(n.children);
    }
  };
  visit(tree);
  return map;
}

/**
 * 把单个 ExportProblem 落到数据库。
 *
 * 策略行为：
 * - create: 已存在 → skip；不存在 → 新建
 * - overwrite: 已存在 → 更新（type/number 不可变）；不存在 → 新建
 * - skip: 已存在 → skip；不存在 → 新建
 *
 * 权限：
 * - 仅 admin 可调用
 * - 若 import 项的 type='P'，会校验 userRole
 *
 * @returns 该条目的处理结果（含写入后的 problem_id）
 */
async function importOne(
  item: ExportProblem,
  strategy: ImportStrategy,
  userId: string,
  userRole: string,
  categoryLookup: Map<string, string>,
): Promise<ImportItemResult> {
  const baseResult: Omit<ImportItemResult, "action" | "problem_id"> = {
    id: item.id,
    display_id: item.display_id,
  };

  // 1. 难度值校验
  if (!isValidDifficulty(item.difficulty)) {
    return {
      ...baseResult,
      action: "failed",
      reason: `非法难度值：${item.difficulty}`,
    };
  }

  // 2. 题目类型校验
  if (!isValidProblemType(item.type)) {
    return {
      ...baseResult,
      action: "failed",
      reason: `非法题目类型：${item.type}`,
    };
  }

  // 3. P 型题需要 admin
  if (item.type === "P" && userRole !== "admin") {
    return {
      ...baseResult,
      action: "failed",
      reason: "P 型题仅管理员可导入",
    };
  }

  // 4. support_package_storage_url 协议前缀校验
  if (item.support_package_storage_url) {
    if (
      !item.support_package_storage_url.startsWith("noj-storage://") &&
      !item.support_package_storage_url.startsWith("noj-download://")
    ) {
      return {
        ...baseResult,
        action: "failed",
        reason: `支持包 URL 协议不受支持：${item.support_package_storage_url}`,
      };
    }
  }

  // 6. 分类解析（按 name 查；找不到的跳过）
  const categoryIds: string[] = [];
  const missingCategories: string[] = [];
  for (const c of item.categories) {
    const id = categoryLookup.get(c.name);
    if (id) {
      categoryIds.push(id);
    } else {
      missingCategories.push(c.name);
    }
  }

  // 7. 检查目标问题是否存在（按 source id）
  const db = getDb();
  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, item.id))
    .limit(1);

  if (existing.length > 0) {
    // 目标已存在
    if (strategy === "create" || strategy === "skip") {
      return {
        ...baseResult,
        action: "skipped",
        reason: strategy === "create"
          ? "目标 id 已存在，create 策略跳过"
          : "目标 id 已存在，skip 策略跳过",
        problem_id: existing[0].id,
      };
    }
    // overwrite：更新元数据
    const updates: Record<string, unknown> = {
      title: item.title,
      description: item.description,
      difficulty: item.difficulty,
      support_package_storage_url: item.support_package_storage_url,
      runtime_config:
        (item.runtime_config as RuntimeConfig | null | undefined) ?? {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      updated_at: new Date().toISOString(),
    };
    await db.update(problems).set(updates).where(eq(problems.id, item.id));
    await syncProblemCategories(item.id, categoryIds);
    return {
      ...baseResult,
      action: "updated",
      problem_id: item.id,
    };
  }

  // 8. 目标不存在 → 新建
  try {
    const created = await createProblem(
      {
        title: item.title,
        description: item.description,
        difficulty: item.difficulty,
        support_package_storage_url: item.support_package_storage_url,
        runtime_config:
          (item.runtime_config as RuntimeConfig | null | undefined) ?? {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              entry: "submission_sample.py",
              call_timeout_ms: 2000,
              memory_limit_mb: 512,
            },
          },
        type: item.type,
        number: item.number,
        category_ids: categoryIds,
      },
      userId,
      userRole,
    );
    const reasonSuffix = missingCategories.length > 0
      ? `（注意：以下分类在当前 DB 不存在，已忽略：${
        missingCategories.join("、")
      }）`
      : undefined;
    return {
      ...baseResult,
      action: "created",
      problem_id: created.id,
      reason: reasonSuffix,
    };
  } catch (err) {
    return {
      ...baseResult,
      action: "failed",
      reason: `创建失败：${err instanceof Error ? err.message : String(err)}${
        missingCategories.length > 0
          ? `；缺失分类：${missingCategories.join("、")}`
          : ""
      }`,
    };
  }
}

/**
 * 批量导入题目。
 *
 * @param input 原始 JSON（来自请求体或文件）
 * @param strategy 三种策略之一
 * @param userId 当前 admin id
 * @param userRole 当前 admin role
 * @returns 导入结果报告（按 action 分桶）
 */
export async function importProblems(
  input: unknown,
  strategy: ImportStrategy,
  userId: string,
  userRole: string,
): Promise<ImportReport> {
  if (
    strategy !== "create" && strategy !== "overwrite" && strategy !== "skip"
  ) {
    throw new BadRequestError(
      `非法导入策略：${strategy}（仅支持 create/overwrite/skip）`,
    );
  }

  const payload = parseImportPayload(input);

  // 预构建分类查找表（一次查询，避免 N+1）
  const categoryLookup = await buildCategoryLookup();

  const created: ImportItemResult[] = [];
  const updated: ImportItemResult[] = [];
  const skipped: ImportItemResult[] = [];
  const failed: ImportItemResult[] = [];

  for (const item of payload.problems) {
    const result = await importOne(
      item,
      strategy,
      userId,
      userRole,
      categoryLookup,
    );
    switch (result.action) {
      case "created":
        created.push(result);
        break;
      case "updated":
        updated.push(result);
        break;
      case "skipped":
        skipped.push(result);
        break;
      case "failed":
        failed.push(result);
        break;
    }
  }

  return {
    strategy,
    total: payload.problems.length,
    created,
    updated,
    skipped,
    failed,
  };
}
