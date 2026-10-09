import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { problems } from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { assertPermission, checkPermission } from "../../identity/index.ts";
import { getStorageProvider } from "../../system/index.ts";
import { resolveProblem } from "./problem-resolve.ts";
import { getSupportPackageBytes } from "./support-package.ts";
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  MAX_ZIP_ENTRIES,
  readEvaluationEntries,
} from "./bundle-parser.ts";
import {
  createProblem,
  deleteProblem,
  updateProblem,
} from "./problems/problems-crud.ts";
import {
  isOiRuntimeConfig,
  type OiRuntimeConfig,
  validateOiRuntimeConfig,
} from "../types/runtime-config.ts";
import { buildOiArchive, readOiArchive } from "./oi-archive.ts";
import {
  loadOiDataFromDraft,
  loadOiDataFromVersion,
} from "./versioning/oi-draft.ts";
import type {
  CreateProblemInput,
  UpdateProblemInput,
} from "../types/problems.ts";

/** OI 文件内容独立存储，索引只对编辑者开放。 */
export interface OiDataFile {
  storage_url: string;
  size: number;
  hash: string;
}

/** 数据路径不能逃逸题包根目录。 */
export function validateOiDataPath(path: string): void {
  if (
    !path || path.startsWith("/") || path.includes("\\") ||
    path.includes("\0") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new BadRequestError("数据文件路径非法");
}

/** 先确认题目可见性及编辑/数据权限，再读取隐藏数据。 */
export async function authorizeOiData(c: Context, reference: string) {
  const userId = c.get("userId") as string;
  const isAdmin = await checkPermission(c, "admin:full_access");
  const problem = await resolveProblem(reference, { userId, isAdmin });
  const own = problem.type === "U" && problem.owner_id === userId;
  await assertPermission(c, own ? "problem:write_own" : "problem:write_any");
  await assertPermission(
    c,
    own ? "problem:package_manage_own" : "problem:package_manage_any",
  );
  if (problem.judge_type !== "oi") {
    throw new BadRequestError("数据编辑仅用于 OI 题");
  }
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, problem.id),
  );
  return { problem, row };
}

/**
 * 读取 OI 数据。
 *
 * **显式来源**（Handbook §6.3）：`draft` 读草稿引用、`version` 读指定/最新已发布
 * 版本引用；未指定时走迁移期兼容路径（`problems.oi_data_files` → 支持包 ZIP）。
 * 新代码一律应显式传 `source`，不得再依赖题目最新版投影。
 */
export async function loadOiData(
  c: Context,
  reference: string,
  options: { source?: "draft" | "version" | "legacy"; versionId?: string } = {},
): Promise<Record<string, Uint8Array>> {
  const { row } = await authorizeOiData(c, reference);
  if (options.source === "draft") {
    return await loadOiDataFromDraft(row.id);
  }
  if (options.source === "version") {
    const versionId = options.versionId ?? row.latest_version_id;
    if (!versionId) return Object.create(null);
    return await loadOiDataFromVersion(versionId);
  }
  const storage = await getStorageProvider();
  if (row.oi_data_files != null) {
    const files: Record<string, Uint8Array> = Object.create(null);
    for (
      const [path, item] of Object.entries(
        row.oi_data_files as Record<string, OiDataFile>,
      )
    ) {
      validateOiDataPath(path);
      files[path] = await storage.get(item.storage_url);
    }
    return files;
  }
  const bytes = await getSupportPackageBytes(
    row.id,
    c.get("userId"),
    c.get("userRole"),
    c,
  );
  return bytes ? await readOiArchive(bytes) : Object.create(null);
}

function validateReferences(config: OiRuntimeConfig, paths: Iterable<string>) {
  const available = new Set(paths);
  const required = [
    ...config.subtasks.flatMap((subtask) =>
      subtask.cases.flatMap((test) => [test.input, test.output])
    ),
    ...(config.compile_extra_files ?? []),
    ...(config.user_extra_files ?? []),
    ...(config.checker_extra_files ?? []),
    ...(config.checker.path ? [config.checker.path] : []),
  ];
  for (const path of required) {
    if (!available.has(path)) {
      throw new BadRequestError(`配置引用缺失文件：${path}`);
    }
  }
}

/** 未编辑数据时复用已发布对象；调整配置只检查文件索引，不解压或重新上传。 */
export async function saveOiMetadata(
  c: Context,
  reference: string,
  input: UpdateProblemInput,
  expectedUpdatedAt?: string,
) {
  const { row } = await authorizeOiData(c, reference);
  if (expectedUpdatedAt !== row.updated_at) {
    throw new ConflictError("题目已被修改，请重新加载后保存");
  }
  if (!isOiRuntimeConfig(input.runtime_config)) {
    throw new BadRequestError("需要 OI 配置");
  }
  validateOiRuntimeConfig(input.runtime_config);
  if (
    JSON.stringify(input.runtime_config) !== JSON.stringify(row.runtime_config)
  ) {
    const paths: string[] = [];
    if (row.oi_data_files != null) {
      paths.push(...Object.keys(row.oi_data_files));
    } else {
      const bytes = await getSupportPackageBytes(
        row.id,
        c.get("userId"),
        c.get("userRole"),
        c,
      );
      // filter=false 只检查 ZIP 目录和安全限额，不解压测试数据。
      if (bytes) readEvaluationEntries(bytes, false, paths);
    }
    validateReferences(input.runtime_config, paths);
  }
  return updateProblem(
    row.id,
    input,
    c.get("userId"),
    c.get("userRole"),
    c,
    false,
    expectedUpdatedAt,
  );
}

/** 文件与配置共同发布；所有对象先写入，失败时补偿清理，不提前删除旧包。 */
export async function saveOiData(
  c: Context,
  reference: string | null,
  input: CreateProblemInput & UpdateProblemInput,
  entries: Record<string, Uint8Array>,
  expectedUpdatedAt?: string,
) {
  let previous: Awaited<ReturnType<typeof authorizeOiData>> | undefined;
  if (reference) previous = await authorizeOiData(c, reference);
  else {
    await assertPermission(c, "problem:create");
    await assertPermission(
      c,
      input.type === "P"
        ? "problem:package_manage_any"
        : "problem:package_manage_own",
    );
  }
  if (!isOiRuntimeConfig(input.runtime_config)) {
    throw new BadRequestError("需要 OI 配置");
  }
  validateOiRuntimeConfig(input.runtime_config);
  if (previous && expectedUpdatedAt !== previous.row.updated_at) {
    throw new ConflictError("题目已被修改，请重新加载后保存");
  }
  let total = 0;
  if (Object.keys(entries).length > MAX_ZIP_ENTRIES) {
    throw new BadRequestError("数据文件过多");
  }
  for (const [path, bytes] of Object.entries(entries)) {
    validateOiDataPath(path);
    total += bytes.length;
    if (bytes.length > MAX_FILE_SIZE || total > MAX_TOTAL_SIZE) {
      throw new BadRequestError("数据大小超过限制");
    }
  }
  validateReferences(input.runtime_config, Object.keys(entries));
  const storage = await getStorageProvider();
  const uploaded: string[] = [];
  let created: string | undefined;
  try {
    const index: Record<string, OiDataFile> = Object.create(null);
    const previousIndex = previous?.row.oi_data_files as
      | Record<string, OiDataFile>
      | null
      | undefined;
    for (const [path, bytes] of Object.entries(entries)) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes as BufferSource),
      );
      const hash = Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const existing = previousIndex?.[path];
      if (existing?.hash === hash && existing.size === bytes.length) {
        index[path] = existing;
        continue;
      }
      const url = await storage.put(
        `oi-file-${crypto.randomUUID()}`,
        bytes,
        "application/octet-stream",
      );
      uploaded.push(url);
      index[path] = {
        storage_url: url,
        size: bytes.length,
        hash,
      };
    }
    const packageUrl = await storage.put(
      `oi-runtime-${crypto.randomUUID()}.zip`,
      await buildOiArchive(entries),
      "application/zip",
    );
    uploaded.push(packageUrl);
    let id = previous?.row.id;
    if (!id) {
      const problem = await createProblem(
        { ...input, judge_type: "oi" },
        c.get("userId"),
        c.get("userRole"),
        c,
      );
      id = created = problem.id;
    }
    const result = await updateProblem(
      id,
      {
        ...input,
        oi_data_files: index,
        support_package_storage_url: packageUrl,
      },
      c.get("userId"),
      c.get("userRole"),
      c,
      true,
      previous?.row.updated_at,
    );
    // 清理只能在数据库引用切换成功之后进行；在途任务的旧包先保留，由存储回收流程处理。
    return result;
  } catch (error) {
    await Promise.allSettled(uploaded.map((url) => storage.delete(url)));
    if (created) {
      await deleteProblem(created, c.get("userId"), c.get("userRole"), c);
    }
    throw error;
  }
}
