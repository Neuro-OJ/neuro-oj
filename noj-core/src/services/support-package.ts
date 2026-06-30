import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems } from "../db/schema.ts";
import { NotFoundError, ForbiddenError } from "../lib/errors.ts";

/**
 * 支持包存储目录（相对 CWD）。
 */
export const PACKAGES_DIR = "data/packages";

/**
 * 获取支持包文件路径。
 */
export function getPackagePath(problemId: string): string {
  return `${PACKAGES_DIR}/${problemId}.zip`;
}

/**
 * 校验用户是否有权管理指定题目的支持包。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
async function checkSupportPackagePermission(
  problemId: string,
  userId?: string,
  userRole?: string,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];

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
 * 保存支持包文件。
 *
 * 将上传的 zip 文件写入 data/packages/<problem_id>.zip，
 * 并更新数据库中的 support_package_path 字段。
 *
 * @returns 保存后的支持包路径
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
export async function saveSupportPackage(
  problemId: string,
  file: { name: string; data: Uint8Array },
  userId?: string,
  userRole?: string,
): Promise<string> {
  await checkSupportPackagePermission(problemId, userId, userRole);

  // 验证文件扩展名为 .zip
  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new Error("仅支持 .zip 格式文件");
  }

  // 确保存储目录存在
  try {
    await Deno.mkdir(PACKAGES_DIR, { recursive: true });
  } catch {
    // 目录已存在则忽略
  }

  const packagePath = getPackagePath(problemId);

  // 原子写入：先写临时文件再 rename
  const tmpPath = `${packagePath}.tmp.${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmpPath, file.data);
    await Deno.rename(tmpPath, packagePath);
  } catch (err) {
    // 清理临时文件
    try {
      await Deno.remove(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw err;
  }

  // 更新数据库
  const db = getDb();
  await db
    .update(problems)
    .set({
      support_package_path: packagePath,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, problemId));

  return packagePath;
}

/**
 * 删除支持包文件。
 *
 * 删除 data/packages/<problem_id>.zip 文件，
 * 并将数据库中的 support_package_path 设为 null。
 * 文件不存在时幂等返回。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 无权操作
 */
export async function deleteSupportPackage(
  problemId: string,
  userId?: string,
  userRole?: string,
): Promise<void> {
  await checkSupportPackagePermission(problemId, userId, userRole);

  const packagePath = getPackagePath(problemId);

  // 删除文件（幂等）
  try {
    await Deno.remove(packagePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // 文件不存在，幂等处理
    } else {
      throw err;
    }
  }

  // 更新数据库
  const db = getDb();
  await db
    .update(problems)
    .set({
      support_package_path: null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, problemId));
}
