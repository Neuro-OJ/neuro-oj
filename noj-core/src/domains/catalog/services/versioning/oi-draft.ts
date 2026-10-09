/**
 * OI 独立编辑路径的草稿写入与来源化读取（Handbook §6.3）。
 *
 * 规则：
 * - 配置与文件索引在**同一次草稿事务**中切换（逐文件引用 + 打包 ZIP 一起换），
 *   避免出现"配置引用新文件、引用仍指旧文件"的中间态被发布；
 * - metadata-only 保存复用草稿文件引用，只检查新配置引用的路径；
 * - 读取显式指定 `draft` 或 `version` 来源，不再默认读 `problems.oi_data_files`；
 * - 上传失败时用引用守卫补偿：仍被其他引用共享的对象不会被误删。
 */

import type { OiRuntimeConfig } from "../../types/runtime-config.ts";
import {
  isOiRuntimeConfig,
  validateOiRuntimeConfig,
} from "../../types/runtime-config.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  compensateUploadedObject,
  getStorageProvider,
  parseStorageUrl,
  sha256Hex,
} from "../../../system/index.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  type DraftObjectRef,
  draftRevisionConflict,
  draftRevisionRequired,
  getProblemDraft,
  loadProblemIdentity,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  saveProblemDraftWithObjects,
} from "./draft.ts";
import { listVersionObjects } from "./publish.ts";
import {
  problemContentKindOf,
  type ProblemDraftContent,
} from "../../types/problem-content.ts";
import { buildOiArchive, readOiArchive } from "../oi-archive.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { eq } from "drizzle-orm";
import {
  problemDraftObjects,
  problemVersionObjects,
} from "../../../../shared/db/schema.ts";

/** 单文件大小与总量上限（与既有 OI 上传约定一致）。 */
export const MAX_OI_FILE_SIZE = 64 * 1024 * 1024;
export const MAX_OI_TOTAL_SIZE = 512 * 1024 * 1024;
export const MAX_OI_FILE_COUNT = 1000;

/** 校验 OI 配置直接引用的文件在给定路径集合内。 */
export function validateOiConfigReferences(
  config: OiRuntimeConfig,
  paths: Iterable<string>,
): void {
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

/** 读取草稿的 OI 逐文件引用。 */
export async function listDraftOiFileRefs(
  problemId: string,
  executor?: Executor,
): Promise<DraftObjectRef[]> {
  const db = executor ?? getDb();
  const rows = await db.select().from(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, problemId),
  );
  return rows
    .filter((row) => row.role === "oi_file")
    .map((row) => ({
      role: "oi_file" as const,
      path: row.path,
      storage_url: row.storage_url,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 读取已发布版本的 OI 逐文件引用。 */
export async function listVersionOiFileRefs(
  versionId: string,
  executor?: Executor,
): Promise<DraftObjectRef[]> {
  const refs = await listVersionObjects(versionId, executor);
  return refs.filter((ref) => ref.role === "oi_file").sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

/** 从引用集合读取全部文件字节；引用为空时回退读同作用域的支持包 ZIP。 */
async function readRefsOrPackage(
  refs: readonly DraftObjectRef[],
  packageUrl: string | null,
): Promise<Record<string, Uint8Array>> {
  const storage = await getStorageProvider();
  if (refs.length === 0) {
    if (!packageUrl) return Object.create(null);
    return await readOiArchive(await storage.get(packageUrl));
  }
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const ref of refs) {
    files[ref.path] = await storage.get(ref.storage_url);
  }
  return files;
}

/** 读取草稿支持包引用（`package.zip`）。 */
async function draftPackageUrl(problemId: string): Promise<string | null> {
  const rows = await getDb().select({
    role: problemDraftObjects.role,
    path: problemDraftObjects.path,
    storage_url: problemDraftObjects.storage_url,
  }).from(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, problemId),
  );
  return rows.find((row) =>
    row.role === "support_package" && row.path === "package.zip"
  )?.storage_url ?? null;
}

/** 读取版本支持包引用（`package.zip`）。 */
async function versionPackageUrl(versionId: string): Promise<string | null> {
  const rows = await getDb().select({
    role: problemVersionObjects.role,
    path: problemVersionObjects.path,
    storage_url: problemVersionObjects.storage_url,
  }).from(problemVersionObjects).where(
    eq(problemVersionObjects.version_id, versionId),
  );
  return rows.find((row) =>
    row.role === "support_package" && row.path === "package.zip"
  )?.storage_url ?? null;
}

/**
 * 读取**草稿**作用域的 OI 数据。
 *
 * 逐文件引用优先；没有逐文件引用时回退解压草稿支持包（存量 OI 题在首次
 * 逐文件保存前只有整包）。
 */
export async function loadOiDataFromDraft(
  problemId: string,
): Promise<Record<string, Uint8Array>> {
  const refs = await listDraftOiFileRefs(problemId);
  const packageUrl = refs.length === 0
    ? await draftPackageUrl(problemId)
    : null;
  return await readRefsOrPackage(refs, packageUrl);
}

/**
 * 读取**已发布版本**作用域的 OI 数据（历史重测/自测必须走这里）。
 */
export async function loadOiDataFromVersion(
  versionId: string,
): Promise<Record<string, Uint8Array>> {
  const refs = await listVersionOiFileRefs(versionId);
  const packageUrl = refs.length === 0
    ? await versionPackageUrl(versionId)
    : null;
  return await readRefsOrPackage(refs, packageUrl);
}

/** 保存 OI 草稿的结果。 */
export interface SaveOiDraftResult {
  problem_id: string;
  revision: number;
  /** 本次是否上传了新文件（false = metadata-only 复用）。 */
  files_changed: boolean;
}

/**
 * 保存 OI 草稿：配置 + 逐文件引用 + 打包 ZIP 在同一次草稿事务中切换。
 *
 * @param entries 省略表示 metadata-only 保存：复用已有草稿文件引用，
 *                但仍校验新配置引用的路径都存在。
 */
export async function saveOiDraft(
  problemId: string,
  input: {
    runtime_config: unknown;
    title?: string;
    description?: string;
    samples?: ProblemDraftContent["samples"];
    /** 预期草稿 revision；缺少 → 428，过时 → 409。 */
    expectedRevision: number | null | undefined;
    actorId?: string | null;
  },
  entries?: Record<string, Uint8Array>,
): Promise<SaveOiDraftResult> {
  const identity = await loadProblemIdentity(problemId);
  if (problemContentKindOf(identity) !== "oi") {
    throw new BadRequestError("数据编辑仅用于 OI 题");
  }
  if (!isOiRuntimeConfig(input.runtime_config)) {
    throw new BadRequestError("需要 OI 配置");
  }
  validateOiRuntimeConfig(input.runtime_config);
  const config = input.runtime_config as OiRuntimeConfig;

  // 步骤 2（Handbook §5.2）：先校验预期 revision，再谈内容与文件上传
  if (input.expectedRevision == null) throw draftRevisionRequired();
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new BadRequestError("预期 revision 必须是非负整数");
  }

  const draft = await getProblemDraft(problemId, identity);
  if (draft.revision !== expectedRevision) {
    throw draftRevisionConflict(expectedRevision, draft.revision);
  }
  const existingRefs = await listDraftOiFileRefs(problemId);
  const existingSupportRef = await getDb().select({
    storage_url: problemDraftObjects.storage_url,
  }).from(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, problemId),
  );
  const existingPackageUrl = existingSupportRef
    .map((row) => row.storage_url)
    .find((url) =>
      url && !existingRefs.some((ref) => ref.storage_url === url)
    ) ??
    null;

  // 校验配置引用：有 entries 时按新集合校验，否则按已有引用校验
  const targetPaths = entries
    ? Object.keys(entries)
    : existingRefs.map((ref) => ref.path);
  validateOiConfigReferences(config, targetPaths);

  const uploaded: string[] = [];
  const filesChanged = entries !== undefined;
  let objects: DraftObjectRef[] = existingRefs;
  let supportUrl = existingPackageUrl;

  try {
    if (entries) {
      if (Object.keys(entries).length > MAX_OI_FILE_COUNT) {
        throw new BadRequestError("数据文件过多");
      }
      let total = 0;
      const byPath = new Map<string, DraftObjectRef>();
      for (const ref of existingRefs) byPath.set(ref.path, ref);

      const storage = await getStorageProvider();
      const nextRefs: DraftObjectRef[] = [];
      for (const [path, bytes] of Object.entries(entries)) {
        if (bytes.length > MAX_OI_FILE_SIZE) {
          throw new BadRequestError("单个数据文件超过大小限制");
        }
        total += bytes.length;
        if (total > MAX_OI_TOTAL_SIZE) {
          throw new BadRequestError("数据大小超过限制");
        }
        const hash = await sha256Hex(bytes);
        const previous = byPath.get(path);
        // 内容寻址：URL 内嵌 checksum 与本次内容一致即可复用，无需重传
        const previousHash = previous
          ? safeChecksum(previous.storage_url)
          : null;
        if (previous && previousHash === hash) {
          nextRefs.push(previous);
          continue;
        }
        const url = await storage.put(
          `oi-file-${crypto.randomUUID()}`,
          bytes,
          "application/octet-stream",
        );
        uploaded.push(url);
        nextRefs.push({ role: "oi_file", path, storage_url: url });
      }

      // 打包 ZIP 与逐文件引用同批切换（同一草稿事务）
      const packageUrl = await storage.put(
        `oi-runtime-${crypto.randomUUID()}.zip`,
        await buildOiArchive(entries),
        "application/zip",
      );
      uploaded.push(packageUrl);
      supportUrl = packageUrl;
      objects = nextRefs;
    }

    const content: ProblemDraftContent = {
      ...(draft.content as ProblemDraftContent),
      kind: "oi",
      title: input.title ?? draft.content.title,
      description: input.description ?? draft.content.description,
      samples: input.samples ?? draft.content.samples ?? [],
      runtime_config: config,
    };

    const nextObjects: DraftObjectRef[] = [...objects];
    if (supportUrl) {
      nextObjects.push({
        role: "support_package",
        path: "package.zip",
        storage_url: supportUrl,
      });
    }

    const saved = await saveProblemDraftWithObjects(problemId, {
      content,
      expectedRevision: input.expectedRevision,
      actorId: input.actorId ?? null,
      objects: nextObjects,
    });
    return {
      problem_id: problemId,
      revision: saved.revision,
      files_changed: filesChanged,
    };
  } catch (error) {
    // 补偿：仍被其他引用共享的对象不会被删除（引用守卫）
    await Promise.allSettled(
      uploaded.map((url) => compensateUploadedObject({ storageUrl: url })),
    );
    throw error;
  }
}

/** 从存储 URL 安全读取内嵌 checksum（解析失败返回 null）。 */
function safeChecksum(url: string): string | null {
  try {
    return parseStorageUrl(url).checksumSha256 ?? null;
  } catch {
    return null;
  }
}

/** 草稿当前是否已存在（用于路由区分"编辑初值"与"已保存草稿"）。 */
export function isSavedDraft(revision: number): boolean {
  return revision !== PROBLEM_DRAFT_VIRTUAL_REVISION;
}
