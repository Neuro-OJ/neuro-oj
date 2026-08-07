import { resolve } from "jsr:@std/path@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import { ForbiddenError, NotFoundError } from "../lib/errors.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { logger } from "../lib/logging.ts";
import { assertPermission } from "../lib/permissions.ts";
import { isValidTemplateFileName } from "../types/problem-bundle.ts";
import type { Context } from "hono";

/**
 * 支持包文件最大字节数（128 MiB）。
 *
 * 引入 S3 存储后不再受 Redis MQ 16MB 消息限制，
 * 上限放宽至 128 MiB。
 */
export const MAX_SUPPORT_PACKAGE_SIZE = 128 * 1024 * 1024; // 128MB

/**
 * 校验用户是否有权管理指定题目的支持包。
 *
 * 若已在外层通过 resolveProblem 获取了题目信息，可传入 problem 跳过重复查询。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
async function checkSupportPackagePermission(
  problemId: string,
  userId?: string,
  userRole?: string,
  problem?: { type: string; owner_id: string },
  c?: Context,
): Promise<void> {
  const db = getDb();

  // 若已在外层获取了题目信息，跳过重复查询
  if (!problem) {
    const existing = await db
      .select({ type: problems.type, owner_id: problems.owner_id })
      .from(problems)
      .where(eq(problems.id, problemId))
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundError("题目不存在");
    }
    problem = existing[0];
  }

  // 管理员可管理任意题目（当有 Context 时走 RBAC 权限检查）
  if (c) {
    // P 型题仅管理员（package_manage_any）
    if (problem.type === "P") {
      await assertPermission(c, "problem:package_manage_any");
      return;
    }
    // U 型题：owner 直接放行；非 owner 需管理员权限
    if (problem.owner_id === (c.var.userId as string)) return;
    await assertPermission(c, "problem:package_manage_any");
    return;
  }

  // 向后兼容：无 Context 时使用旧的 userRole 检查
  if (userRole === "admin") return;

  // 普通用户仅可管理自己的 U 型题目
  if (problem.type === "P") {
    throw new ForbiddenError("仅管理员可管理管理题的支持包");
  }
  if (problem.owner_id !== userId) {
    throw new ForbiddenError("无权管理此题目的支持包");
  }
}

/**
 * 删除支持包。
 *
 * 通过 StorageProvider 删除已存储的数据，
 * 并将数据库中的 `support_package_storage_url` 设为 null。
 * 幂等操作。
 *
 * @param problem - 可选的预获取题目信息（type, owner_id），避免重复查询
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
export async function deleteSupportPackage(
  problemId: string,
  userId?: string,
  userRole?: string,
  problem?: { type: string; owner_id: string },
  c?: Context,
): Promise<void> {
  await checkSupportPackagePermission(problemId, userId, userRole, problem, c);

  const db = getDb();

  // 获取当前 storage URL
  const [current] = await db
    .select({ storageUrl: problems.support_package_storage_url })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);

  // 通过 StorageProvider 删除
  if (current?.storageUrl) {
    const storage = await getStorageProvider();
    try {
      await storage.delete(current.storageUrl);
    } catch (err) {
      logger.error("删除支持包失败", { storage_url: current.storageUrl, err });
      // 删除失败不阻塞 DB 更新
    }
  }

  // 更新数据库
  await db
    .update(problems)
    .set({
      support_package_storage_url: null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, problemId));
}

/**
 * 获取支持包原始字节。
 *
 * 通过 StorageProvider 读取支持包数据。
 * 用于下载端点（GET /support-package）等需要返回文件内容的场景。
 *
 * @returns 支持包 zip 字节，无支持包时返回 null
 */
export async function getSupportPackageBytes(
  problemId: string,
  userId?: string,
  userRole?: string,
  c?: Context,
): Promise<Uint8Array | null> {
  const db = getDb();

  const [problem] = await db
    .select({
      type: problems.type,
      owner_id: problems.owner_id,
      storageUrl: problems.support_package_storage_url,
    })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);

  if (!problem) {
    throw new NotFoundError("题目不存在");
  }

  // 权限校验：owner 可管理自己的支持包；非 owner 仅管理员（package_manage_any）
  if (c) {
    if (problem.owner_id !== (c.var.userId as string)) {
      await assertPermission(c, "problem:package_manage_any");
    }
  } else if (userRole !== "admin" && problem.owner_id !== userId) {
    throw new ForbiddenError("无权下载此题目的支持包");
  }

  if (!problem.storageUrl) {
    return null;
  }

  const storage = await getStorageProvider();
  return storage.get(problem.storageUrl);
}

/**
 * 获取题目的初始代码模板（前端编辑器 starter code）。
 *
 * 读取题目源码目录 `data/problems-src/<number>/problem.json` 的 `template`
 * 字段索引的文件（缺省默认 `"template.py"`，兼容未声明该字段的旧题目）。
 *
 * 模板仅供前端编辑器初始填充，与评测参考实现解耦——不再回退
 * `submission_sample.py` / `submission.py`（参考实现已从源码目录移除）。
 *
 * 生产环境需要将模板单独存储（TODO: 上传至 S3/对象存储）。
 * 目前 dev 模式：直接从源码目录读取。
 *
 * @param problemNumber 题号（problems-src 目录按题号命名）
 * @param srcRoot 源码目录根（默认 `data/problems-src`，测试可注入临时目录）
 * @returns 模板内容，文件不存在返回 null
 */
export async function getProblemTemplate(
  problemNumber: number,
  srcRoot: string = resolve(Deno.cwd(), "data", "problems-src"),
): Promise<{ content: string; language: string } | null> {
  // problems-src 目录按题号命名（1001/1002/1003），题目 id 为 UUID，
  // 因此调用方必须传入 number 而非 id。
  const srcDir = resolve(srcRoot, String(problemNumber));

  // 1. 读 manifest.template 字段（缺省 "template.py"；非法值同样回退默认名）
  let templateFile = "template.py";
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(resolve(srcDir, "problem.json")),
    ) as { template?: unknown };
    if (
      typeof manifest.template === "string" &&
      isValidTemplateFileName(manifest.template)
    ) {
      templateFile = manifest.template;
    }
  } catch {
    // manifest 缺失或损坏：回退默认 template.py
  }

  // 2. 读取模板文件
  try {
    const content = await Deno.readTextFile(resolve(srcDir, templateFile));
    // TODO: 多语言时根据 problem.default_language 返回，目前固定 python3
    return { content, language: "python3" };
  } catch (err) {
    // 仅文件不存在视为"无模板"（404），其余错误（权限/IO）上抛便于排障
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
