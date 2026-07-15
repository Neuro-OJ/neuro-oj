import { resolve } from "jsr:@std/path@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";

/**
 * 支持包文件最大字节数（128 MiB）。
 *
 * 引入 S3 存储后不再受 Redis MQ 16MB 消息限制，
 * 上限放宽至 128 MiB。
 */
export const MAX_SUPPORT_PACKAGE_SIZE = 128 * 1024 * 1024; // 128MB

/**
 * 支持包存储键前缀。
 */
const PACKAGES_KEY_PREFIX = "packages/";

/**
 * 构建支持包存储键。
 */
function buildPackageKey(problemId: string): string {
  return `${PACKAGES_KEY_PREFIX}${problemId}.zip`;
}

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

  // 管理员可管理任意题目
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
 * 保存支持包。
 *
 * 通过 StorageProvider 存储 zip 数据，返回 `noj-storage://` URL，
 * 并更新数据库中的 `support_package_storage_url` 字段。
 *
 * @param problem - 可选的预获取题目信息（type, owner_id），避免重复查询
 * @returns `noj-storage://` URL
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
export async function saveSupportPackage(
  problemId: string,
  file: { name: string; data: Uint8Array },
  userId?: string,
  userRole?: string,
  problem?: { type: string; owner_id: string },
): Promise<string> {
  await checkSupportPackagePermission(problemId, userId, userRole, problem);

  // 验证文件扩展名为 .zip（防御性校验，路由层已做相同检查）
  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new ValidationError("仅支持 .zip 格式文件");
  }

  // 验证文件大小（防御性校验，路由层已做相同检查）
  if (file.data.length > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new ValidationError(
      `支持包大小超过限制（最大 ${
        (MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024).toFixed(0)
      }MB）`,
    );
  }

  // 通过 StorageProvider 存储
  const storage = await getStorageProvider();
  const storageUrl = await storage.put(
    buildPackageKey(problemId),
    file.data,
    "application/zip",
  );

  // 更新数据库
  const db = getDb();
  await db
    .update(problems)
    .set({
      support_package_storage_url: storageUrl,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, problemId));

  return storageUrl;
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
): Promise<void> {
  await checkSupportPackagePermission(problemId, userId, userRole, problem);

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
      console.error(
        `删除支持包失败 (${current.storageUrl}):`,
        err instanceof Error ? err.message : String(err),
      );
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

  // 权限校验
  if (userRole !== "admin" && problem.owner_id !== userId) {
    throw new ForbiddenError("无权下载此题目的支持包");
  }

  if (!problem.storageUrl) {
    return null;
  }

  const storage = await getStorageProvider();
  return await storage.get(problem.storageUrl);
}

/**
 * 获取题目的初始代码模板（submission.py）。
 *
 * 优先级：
 * 1. 本地源目录 `data/problems-src/<id>/submission.py`（开发环境）
 * 2. 不支持包时返回 null（路由层返回 404）
 *
 * 生产环境需要将 submission.py 单独存储（TODO: 上传至 S3/对象存储）。
 * 目前 dev 模式：直接从源码目录读取。
 */
export async function getProblemTemplate(
  problemId: string,
): Promise<{ content: string; language: string } | null> {
  // TODO: 生产环境从 support package 解压或单独的对象存储读取
  const fsRoot = resolve(
    Deno.cwd(),
    "data",
    "problems-src",
    problemId,
    "submission.py",
  );

  try {
    const content = await Deno.readTextFile(fsRoot);
    // TODO: 多语言时根据 problem.default_language 返回，目前固定 python3
    return { content, language: "python3" };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw err;
  }
}
