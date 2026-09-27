import { resolve } from "jsr:@std/path@^1";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { getDb } from "./../../../shared/db/connection.ts";
import { problems } from "./../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { getStorageProvider } from "./../../system/index.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "catalog"]);
import { assertPermission } from "./../../identity/index.ts";
import {
  DEFAULT_TEMPLATE_FILE,
  isValidTemplateFileName,
  MAX_TEMPLATE_BYTES,
} from "./../types/problem-bundle.ts";
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
    // NOJ-102：U 型 owner 需 package_manage_own；非 owner 需管理员权限。
    if (problem.owner_id === (c.var.userId as string)) {
      await assertPermission(c, "problem:package_manage_own");
      return;
    }
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

  // 权限校验：owner 需 package_manage_own；非 owner 仅管理员（package_manage_any）
  if (c) {
    if (problem.owner_id === (c.var.userId as string)) {
      await assertPermission(c, "problem:package_manage_own");
    } else {
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
 * 获取题目的初始代码模板（前端编辑器 starter code）——**本地源码目录回退路径**。
 *
 * 运行期入口是 {@link resolveProblemTemplate}，解析顺序为
 * 「DB 持久化内容 → 已存储支持包内的模板 → 本地源码目录」。本函数只实现最后一级：
 * 按 `problem.json` 的 `template` 字段索引源码目录中的模板文件（缺省 `template.py`）。
 *
 * 目录归属判定（2026-09 修正）：标题必须一致；manifest 显式声明了 `number` 时题号
 * 也必须一致。**未声明 `number` 的 manifest 按标题匹配**——题号是导入时由平台自增
 * 分配的，出题人本地 manifest 普遍不写 number，旧规则（`manifest.number ===
 * problem.number` 恒不等）会让这些题目的模板永远读不到。
 *
 * 模板仅供前端编辑器初始填充，与评测参考实现解耦——不再回退
 * `submission_sample.py` / `submission.py`（参考实现已从源码目录移除）。
 *
 * @param problem 用于确认源码归属的数据库题目元数据
 * @param srcRoot 源码目录根（默认 `data/problems-src`，测试可注入临时目录）
 * @returns 模板内容，文件不存在返回 null
 */
export async function getProblemTemplate(
  problem: { number: number; title: string },
  srcRoot: string = resolve(Deno.cwd(), "data", "problems-src"),
): Promise<{ content: string; language: string } | null> {
  const srcDirs: string[] = [];

  try {
    for await (const entry of Deno.readDir(srcRoot)) {
      if (!entry.isDirectory) continue;

      const srcDir = resolve(srcRoot, entry.name);
      try {
        const manifest = JSON.parse(
          await Deno.readTextFile(resolve(srcDir, "problem.json")),
        ) as { number?: unknown; title?: unknown };
        if (manifest.title !== problem.title) continue;
        // number 仅在 manifest 显式声明时参与比对（缺省 → 按标题唯一匹配）
        if (
          manifest.number !== undefined && manifest.number !== problem.number
        ) {
          continue;
        }
        srcDirs.push(srcDir);
      } catch {
        // 忽略缺失或损坏 manifest 的目录：无法证明其属于当前题目。
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }

  // 自动分配题号时目录名不可靠；没有唯一归属时不得返回其他题目的模板。
  if (srcDirs.length !== 1) return null;
  const srcDir = srcDirs[0];

  // 1. 读 manifest.template 字段（缺省 "template.py"；非法值同样回退默认名）
  let templateFile = DEFAULT_TEMPLATE_FILE;
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

/**
 * 从已存储的支持包 zip 中取出模板文件内容（历史题目回退路径）。
 *
 * 用 fflate 的 `filter` 在**中央目录阶段**筛条目，只解压目标条目——避免为读一个
 * 几 KB 的模板把上百 MiB 评测数据全量解压进内存。
 *
 * 包内模板文件名不可知（`problem.json` 在导入时已被剥离），因此按默认名
 * `template.py` 及其 `./template.py`（部分 zip 工具会给根级条目加前缀）探测。
 *
 * @returns 模板内容；包内无该条目或包损坏时返回 null（尽力而为的回退，不抛错）
 */
export function extractTemplateFromPackage(
  zipBytes: Uint8Array,
): string | null {
  const candidates = [
    DEFAULT_TEMPLATE_FILE,
    `./${DEFAULT_TEMPLATE_FILE}`,
  ];
  const wanted = new Set(candidates);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, { filter: (file) => wanted.has(file.name) });
  } catch (err) {
    logger.warn("支持包解析失败，无法回退读取模板", { err });
    return null;
  }

  for (const name of candidates) {
    const raw = entries[name];
    if (!raw) continue;
    if (raw.byteLength > MAX_TEMPLATE_BYTES) {
      logger.warn("支持包内模板文件超过大小上限，已忽略", {
        template: name,
        size: raw.byteLength,
        limit: MAX_TEMPLATE_BYTES,
      });
      return null;
    }
    return new TextDecoder().decode(raw);
  }
  return null;
}

/**
 * 解析题目的初始代码模板（编辑器 starter code 的运行期唯一入口）。
 *
 * 解析顺序：
 * 1. `problems.template_content`——导入题目包时从包内持久化（生产主路径）
 * 2. 已存储支持包内的模板文件（仅当第 1 级为 `NULL`：本列引入前的存量行）
 * 3. 本地源码目录 `data/problems-src`（仅开发环境/样例题有意义）
 *
 * `template_content` 为**空串**表示导入时已核对"包内无模板"，此时跳过第 2 级
 * ——否则每打开一次编辑器都要把整个支持包（上限 128 MiB）从对象存储拉一遍。
 *
 * 前两级都不依赖进程所在机器的目录结构，因此容器化生产（镜像里没有私有题源）
 * 同样能返回模板；这正是此前线上所有题目模板恒 404 的根因所在。
 *
 * @param problem 题目元数据（需 `id` 以读取持久化内容/支持包）
 * @param options.packageBytes 调用方已读取的支持包字节（传入可省一次下载）
 * @param options.srcRoot 本地源码根（缺省 `data/problems-src`，测试注入）
 * @returns 模板内容；无任何可用来源时返回 null（路由据此返回 404）
 */
export async function resolveProblemTemplate(
  problem: { id: string; number: number; title: string },
  options: { packageBytes?: Uint8Array | null; srcRoot?: string } = {},
): Promise<{ content: string; language: string } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      templateContent: problems.template_content,
      storageUrl: problems.support_package_storage_url,
    })
    .from(problems)
    .where(eq(problems.id, problem.id))
    .limit(1);

  // 1. 导入时持久化的内容（不依赖部署目录，也不需要下载支持包）
  if (row && row.templateContent !== null) {
    if (row.templateContent !== "") {
      // TODO: 多语言时根据 problem.default_language 返回，目前固定 python3
      return { content: row.templateContent, language: "python3" };
    }
    // 空串 = 导入时已核对"包内无模板"：不再为读模板下载整个支持包，
    // 直接走本地源码目录回退（开发环境/样例题）。
    return await getProblemTemplate(
      { number: problem.number, title: problem.title },
      options.srcRoot,
    );
  }

  // 2. 存量行（本列引入前导入，来源未知）：支持包内仍带模板时按默认名探测
  let packageBytes = options.packageBytes ?? null;
  if (!packageBytes && row?.storageUrl) {
    try {
      const storage = await getStorageProvider();
      packageBytes = await storage.get(row.storageUrl);
    } catch (err) {
      // 存储不可用不应让编辑器整页失败：记录后继续走本地源码回退。
      logger.warn("读取支持包以解析模板失败", {
        problem_id: problem.id,
        err,
      });
    }
  }
  if (packageBytes) {
    const content = extractTemplateFromPackage(packageBytes);
    if (content !== null) return { content, language: "python3" };
  }

  // 3. 本地源码目录（开发环境/样例题）
  return await getProblemTemplate(
    { number: problem.number, title: problem.title },
    options.srcRoot,
  );
}
