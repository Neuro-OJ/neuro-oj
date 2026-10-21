/**
 * 题目版本发布与读取（Handbook §2.3、§5.3）。
 *
 * 发布是**独立动作**：不改有效策略、不推送 Judge、不重测任何提交。
 * 只有它有权更新 `problems` 上的"最新版投影"。
 *
 * 流程对应 Handbook §5.3 九步：
 * 1. 读草稿与文件引用做完整预检（IO 在锁外）；
 * 2. 事务内锁定题目与草稿，复查 revision 与基线；
 * 3. 基线必须仍是最新版（别人已发布 → 409）；
 * 4. 题型与提交模式不可变；
 * 5. 对象状态、OI 配置引用文件、客观题答案、运行配置完整性；
 * 6. 计算内容哈希，相同内容返回现有版本（不制造空版本）；
 * 7. 分配版本号，插入内容与不可变文件引用；
 * 8. 更新最新版指针、最新版投影与草稿基线；
 * 9. 事务内写审计；提交后由 application/read-model 发送搜索索引事件。
 */

import {
  assertDraftContentSecurity,
  assertPublishedRuntimeSafety,
} from "./content-security.ts";
import { and, eq, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import type { DbTx, Executor } from "../../../../shared/db/executor.ts";
import type { Actor } from "../../../access/contracts/actor.ts";
import { appendAuditLogTx } from "../../../platform/contracts/audit.ts";
import { updateStorageObjectSha256Tx } from "../../../assets/contracts/object-metadata.ts";
import {
  domainProblemBindings,
  problemDrafts,
  problems,
  problemVersionObjects,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { publishSearchIndexEvent } from "../../../../shared/search-events.ts";
import { enqueueSearchIndexTaskTx } from "../../../application/search-tasks.ts";
import { recordPublishedBindingChanges } from "../workspace/education-events.ts";
import {
  assertContentKindTransition,
  computeProblemContentHash,
  type ProblemContentFileRef,
  type ProblemContentKind,
  problemContentKindOf,
  type ProblemContentV1,
  validateProblemContent,
} from "../../types/problem-content.ts";
import {
  assertStorageObjectBindable,
  getStorageObject,
} from "../../../assets/contracts/cross-module/services_registry.ts";
import {
  getStorageProvider,
  parseStorageUrl,
} from "../../../assets/storage/mod.ts";
import {
  draftBaselineConflict,
  type DraftObjectRef,
  draftRevisionConflict,
  draftRevisionRequired,
  getProblemDraft,
  listDraftObjects,
  loadProblemIdentity,
} from "./draft.ts";

/** 支持包固定逻辑路径（Handbook §2.5）。 */
export const SUPPORT_PACKAGE_PATH = "package.zip";

/** 预检问题。 */
export interface PublishPreflightIssue {
  code: string;
  message: string;
  path?: string;
}

/** 单个文件引用的预检结果。 */
export interface PublishPreflightFile {
  role: string;
  path: string;
  state: string;
  /** 物理对象是否存在（`verifyObjects` 为 true 时才有意义）。 */
  exists: boolean | null;
  byte_size: number | null;
  sha256: string | null;
}

/** 发布预检报告。 */
export interface PublishPreflightReport {
  problem_id: string;
  revision: number;
  base_version_id: string | null;
  content_complete: boolean;
  /** 内容完整且可计算时给出；否则为 null。 */
  content_hash: string | null;
  files: PublishPreflightFile[];
  errors: PublishPreflightIssue[];
  warnings: PublishPreflightIssue[];
  ready: boolean;
}

/** 发布结果。 */
export interface PublishProblemVersionResult {
  problem_id: string;
  version_id: string;
  version: number;
  draft_revision: number;
  unchanged: boolean;
}

/** 版本元数据（列表用）。 */
export interface ProblemVersionSummary {
  id: string;
  problem_id: string;
  version: number;
  schema_version: number;
  origin: string;
  content_sha256: string | null;
  change_note: string;
  published_by: string | null;
  published_at: string;
  is_latest: boolean;
}

/** 供读取路径使用的版本内容视图。 */
export interface ProblemVersionContentView {
  version_id: string;
  version: number;
  content: ProblemContentV1;
  is_latest: boolean;
}

/** OI 运行配置直接引用的文件路径（发布前必须全部有引用）。 */
function collectOiReferencedPaths(content: ProblemContentV1): string[] {
  if (content.kind !== "oi") return [];
  const config = content.runtime_config;
  return [
    ...config.subtasks.flatMap((subtask) =>
      subtask.cases.flatMap((test) => [test.input, test.output])
    ),
    ...(config.compile_extra_files ?? []),
    ...(config.user_extra_files ?? []),
    ...(config.checker_extra_files ?? []),
    ...(config.checker.path ? [config.checker.path] : []),
  ];
}

/** 断言草稿内容可发布（完整性 + 类别一致），返回收窄后的内容。 */
function assertPublishableContent(
  kind: ProblemContentKind,
  content: unknown,
): ProblemContentV1 {
  validateProblemContent(kind, content);
  return content;
}

/** 把草稿引用转成内容哈希输入。 */
function toHashFileRefs(
  refs: readonly DraftObjectRef[],
  shaByUrl: ReadonlyMap<string, string | null>,
): ProblemContentFileRef[] {
  return refs.map((ref) => ({
    role: ref.role,
    path: ref.path,
    sha256: shaByUrl.get(ref.storage_url) ?? null,
  }));
}

/**
 * 解析文件引用参与内容哈希的**实际 SHA**（tracking #22）。
 *
 * 优先级：
 * 1. `storage_objects.sha256`（服务端登记的真实哈希）；
 * 2. 存储 URL 内嵌的 `checksum_sha256`（内容寻址 URL 自带，local/s3 均支持）。
 *
 * 两者都没有时返回 null——调用方必须**拒绝发布**，绝不能拿空串参与哈希：
 * 两个不同字节、相同逻辑路径且哈希未知的对象会算出同一个内容哈希，被误判为
 * `unchanged`，进而发布出与预检对象不一致的版本。
 */
function resolveFileSha(
  ref: DraftObjectRef,
  record: { sha256: string | null } | null,
): string | null {
  if (record?.sha256) return record.sha256;
  try {
    return parseStorageUrl(ref.storage_url).checksumSha256 ?? null;
  } catch {
    return null;
  }
}

/**
 * 补齐所有引用的实际 SHA（发布前调用）。
 *
 * 返回 `{ shaByUrl, missing }`：`missing` 非空表示存在无法取得实际哈希的引用，
 * 发布必须失败（存量未知哈希可在本次核实后升级为已知）。
 * 传入事务时不把解析出的哈希直接写进 assets 的表，而是经 assets 的
 * `updateStorageObjectSha256Tx` 合同写回登记行：跨模块只走 owner 的窄能力。
 */
async function resolveFileShas(
  refs: readonly DraftObjectRef[],
  persist?: DbTx,
): Promise<{
  shaByUrl: Map<string, string | null>;
  missing: DraftObjectRef[];
}> {
  const shaByUrl = new Map<string, string | null>();
  const missing: DraftObjectRef[] = [];
  for (const ref of refs) {
    const record = await getStorageObject(ref.storage_url, persist);
    const sha = resolveFileSha(ref, record);
    shaByUrl.set(ref.storage_url, sha);
    if (!sha) {
      missing.push(ref);
      continue;
    }
    // 存量登记为未知哈希时补齐实际值（不再把空串当作哈希输入）。
    if (persist && !record?.sha256) {
      await updateStorageObjectSha256Tx(persist, ref.storage_url, sha);
    }
  }
  return { shaByUrl, missing };
}

/**
 * 发布预检（不写库）。
 *
 * `verifyObjects` 为 true 时对每个引用做一次后端存在性查询（发布路径使用；
 * 编辑器实时预检可关掉以减少 IO）。
 */
export async function preflightProblemDraft(
  problemId: string,
  options: { verifyObjects?: boolean } = {},
): Promise<PublishPreflightReport> {
  const identity = await loadProblemIdentity(problemId);
  const draft = await getProblemDraft(problemId, identity);
  const expectedKind: ProblemContentKind = problemContentKindOf(identity);
  const refs = await listDraftObjects(problemId);
  const errors: PublishPreflightIssue[] = [];
  const warnings: PublishPreflightIssue[] = [];

  if (draft.content.kind !== expectedKind) {
    errors.push({
      code: "CONTENT_KIND_IMMUTABLE",
      message: `题目内容类别不可变：期望 ${expectedKind}，实际 ${
        String(draft.content.kind)
      }`,
    });
  }

  let contentComplete = false;
  let hash: string | null = null;
  let publishable: ProblemContentV1 | null = null;
  if (errors.length === 0) {
    try {
      publishable = assertPublishableContent(expectedKind, draft.content);
      await assertPublishedRuntimeSafety(publishable);
      contentComplete = true;
    } catch (error) {
      errors.push({
        code: "CONTENT_INCOMPLETE",
        message: error instanceof Error ? error.message : "题目内容不完整",
      });
    }
  }

  // 文件引用：状态必须可绑定，固定路径约束，配置引用必须存在
  const shaByUrl = new Map<string, string | null>();
  const files: PublishPreflightFile[] = [];
  const provider = options.verifyObjects ? await getStorageProvider() : null;
  for (const ref of refs) {
    const record = await getStorageObject(ref.storage_url);
    const sha = resolveFileSha(ref, record);
    shaByUrl.set(ref.storage_url, sha);
    let exists: boolean | null = null;
    if (provider) {
      try {
        exists = (await provider.stat(ref.storage_url)).exists;
      } catch {
        exists = false;
      }
    }
    files.push({
      role: ref.role,
      path: ref.path,
      state: record?.state ?? "unknown",
      exists,
      byte_size: record?.byte_size ?? null,
      sha256: sha,
    });
    // 实际 SHA 缺失时禁止发布（tracking #22）：空哈希参与内容哈希会让不同字节、
    // 相同路径的两个对象被判为"内容未变"。
    if (!sha) {
      errors.push({
        code: "STORAGE_OBJECT_SHA_UNKNOWN",
        message: `无法取得文件实际 SHA-256，禁止发布：${ref.path}`,
        path: ref.path,
      });
    }
    if (record && (record.state === "deleting" || record.state === "deleted")) {
      errors.push({
        code: "STORAGE_OBJECT_DELETING",
        message: `文件已进入删除流程：${ref.path}`,
        path: ref.path,
      });
    } else if (record?.state === "missing" || exists === false) {
      errors.push({
        code: "STORAGE_OBJECT_MISSING",
        message: `文件在后端不存在：${ref.path}`,
        path: ref.path,
      });
    } else if (!record || record.state === "unknown") {
      warnings.push({
        code: "STORAGE_OBJECT_UNVERIFIED",
        message: `文件未核实存在性（存量登记）：${ref.path}`,
        path: ref.path,
      });
    }
    if (ref.role === "support_package" && ref.path !== SUPPORT_PACKAGE_PATH) {
      errors.push({
        code: "SUPPORT_PACKAGE_PATH_INVALID",
        message: `支持包必须使用固定逻辑路径 ${SUPPORT_PACKAGE_PATH}`,
        path: ref.path,
      });
    }
  }

  if (publishable && publishable.kind === "oi") {
    const available = new Set(
      refs.filter((ref) => ref.role === "oi_file").map((ref) => ref.path),
    );
    for (const path of collectOiReferencedPaths(publishable)) {
      if (!available.has(path)) {
        errors.push({
          code: "OI_FILE_REFERENCE_MISSING",
          message: `OI 配置引用缺失文件：${path}`,
          path,
        });
      }
    }
  }

  if (errors.length === 0 && publishable) {
    hash = await computeProblemContentHash(
      publishable,
      toHashFileRefs(refs, shaByUrl),
    );
  }

  return {
    problem_id: problemId,
    revision: draft.revision,
    base_version_id: draft.base_version_id,
    content_complete: contentComplete,
    content_hash: hash,
    files,
    errors,
    warnings,
    ready: errors.length === 0,
  };
}

/**
 * 发布草稿为新版本。
 *
 * `actor` 是显式业务身份：审计与版本作者都取自它，不接受可选 userId 或从
 * Hono Context 猜测操作者。
 *
 * @throws {AppError} 428 缺少预期 revision；409 revision/基线冲突或对象在删除中；
 *                    400 内容不完整
 */
export async function publishProblemVersion(
  problemId: string,
  input: {
    expectedRevision: number | null | undefined;
    changeNote?: string;
    actor: Actor;
    /** 域路由在发布事务内重新确认授权，与资源写入共用锁和连接。 */
    authorize?: (executor: Executor) => Promise<void>;
  },
): Promise<PublishProblemVersionResult> {
  if (input.expectedRevision == null) throw draftRevisionRequired();
  const expected = Number(input.expectedRevision);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new AppError("预期 revision 必须是非负整数", 400, "INVALID_REVISION");
  }

  // 步骤 1：锁外完整预检（含物理对象存在性），避免持锁做 IO
  const preflight = await preflightProblemDraft(problemId, {
    verifyObjects: true,
  });
  if (!preflight.ready) {
    throw new AppError(
      `发布预检未通过：${preflight.errors.map((e) => e.message).join("；")}`,
      400,
      "PUBLISH_PREFLIGHT_FAILED",
      { issues: preflight.errors },
    );
  }

  if (preflight.revision !== expected) {
    throw draftRevisionConflict(expected, preflight.revision);
  }
  const checkedIdentity = await loadProblemIdentity(problemId);
  const checkedDraft = await getProblemDraft(problemId, checkedIdentity);
  if (checkedDraft.revision !== preflight.revision) {
    throw draftRevisionConflict(preflight.revision, checkedDraft.revision);
  }
  await assertDraftContentSecurity(
    checkedIdentity,
    checkedDraft.content,
    input.actor.kind === "user" ? input.actor.userId : null,
  );
  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    await input.authorize?.(tx);
    // 步骤 2：锁定题目与草稿
    const locked = unwrapRows<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM problems WHERE id = ${problemId} FOR UPDATE`,
      ) as { id: string }[],
    );
    if (locked.length === 0) {
      throw new AppError(`题目不存在：${problemId}`, 404, "PROBLEM_NOT_FOUND");
    }
    const [identity] = await tx.select().from(problems).where(
      eq(problems.id, problemId),
    ).limit(1);
    const draftRows = unwrapRows<
      { revision: number; base_version_id: string | null; content: unknown }
    >(
      await tx.execute(
        sql`SELECT revision, base_version_id, content FROM problem_drafts WHERE problem_id = ${problemId} FOR UPDATE`,
      ) as {
        revision: number;
        base_version_id: string | null;
        content: unknown;
      }[],
    );
    const draftRow = draftRows[0];
    const currentRevision = draftRow?.revision ?? 0;
    const baseVersionId = draftRow
      ? draftRow.base_version_id
      : identity.latest_version_id;

    if (currentRevision !== preflight.revision) {
      throw draftRevisionConflict(preflight.revision, currentRevision);
    }
    // 步骤 2 续：复查 revision 与基线
    if (currentRevision !== expected) {
      throw draftRevisionConflict(expected, currentRevision);
    }
    if (baseVersionId !== identity.latest_version_id) {
      throw draftBaselineConflict();
    }

    // 锁内确认的草稿内容必须与预检内容同一 revision（防"检查 A 草稿发布 B 草稿"）。
    // 预检报告的 hash 已绑定该 revision，内容变化必然带来 revision 变化。
    const expectedKind = problemContentKindOf(identity);
    const content = assertPublishableContent(
      expectedKind,
      draftRow?.content ??
        (await getProblemDraft(problemId, identity, tx)).content,
    );

    // 步骤 3/4：题型与提交模式不可变
    let latestContent: ProblemContentV1 | null = null;
    if (identity.latest_version_id) {
      const [latest] = await tx.select().from(problemVersions).where(
        eq(problemVersions.id, identity.latest_version_id),
      ).limit(1);
      latestContent = (latest?.content as ProblemContentV1 | undefined) ?? null;
    }
    if (latestContent) {
      assertContentKindTransition(
        latestContent.kind,
        latestContent.kind === "ai" ? latestContent.submission_mode : null,
        content,
      );
    }

    // 步骤 5：对象状态（DB 内复查，不重复 IO）
    const refs = await listDraftObjects(problemId, tx);
    for (const ref of refs) {
      await assertStorageObjectBindable(ref.storage_url, tx);
    }

    // 步骤 6：内容哈希；相同内容返回现有版本
    const { shaByUrl, missing } = await resolveFileShas(refs, tx);
    if (missing.length > 0) {
      throw new AppError(
        `无法取得文件实际 SHA-256，禁止发布：${
          missing.map((ref) => ref.path).join("、")
        }`,
        409,
        "STORAGE_OBJECT_SHA_UNKNOWN",
      );
    }
    const oiDataFiles: Record<
      string,
      { storage_url: string; size: number; hash: string }
    > = {};
    let supportPackageUrl: string | null = null;
    for (const ref of refs) {
      if (ref.role === "support_package") supportPackageUrl = ref.storage_url;
      if (ref.role === "oi_file") {
        const record = await getStorageObject(ref.storage_url, tx);
        oiDataFiles[ref.path] = {
          storage_url: ref.storage_url,
          size: record?.byte_size ?? 0,
          // 文件实际 SHA 已在上一步核实并写回登记行：这里绝不再用空串。
          hash: shaByUrl.get(ref.storage_url) ?? "",
        };
      }
    }
    const contentHash = await computeProblemContentHash(
      content,
      toHashFileRefs(refs, shaByUrl),
    );
    if (contentHash !== preflight.content_hash) {
      throw new AppError(
        "预检后内容或文件引用已变化",
        409,
        "DRAFT_REVISION_CONFLICT",
      );
    }
    const [existing] = await tx.select().from(problemVersions).where(
      and(
        eq(problemVersions.problem_id, problemId),
        eq(problemVersions.content_sha256, contentHash),
        identity.latest_version_id
          ? eq(problemVersions.id, identity.latest_version_id)
          : sql`FALSE`,
      ),
    ).limit(1);
    if (existing) {
      return {
        problem_id: problemId,
        version_id: existing.id,
        version: existing.version,
        draft_revision: currentRevision,
        unchanged: true,
      };
    }

    // 步骤 7：分配版本号，插入内容与不可变文件引用
    const [maxRow] = await tx.select({
      max: sql<number>`COALESCE(MAX(${problemVersions.version}), 0)::int`,
    }).from(problemVersions).where(eq(problemVersions.problem_id, problemId));
    const nextVersion = (maxRow?.max ?? 0) + 1;
    const versionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await tx.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: nextVersion,
      schema_version: 1,
      origin: "published",
      content: content as unknown as Record<string, unknown>,
      content_sha256: contentHash,
      change_note: input.changeNote ?? "",
      published_by: input.actor.kind === "user" ? input.actor.userId : null,
      published_at: now,
    });
    if (refs.length > 0) {
      await tx.insert(problemVersionObjects).values(
        refs.map((ref) => ({
          version_id: versionId,
          role: ref.role,
          path: ref.path,
          storage_url: ref.storage_url,
        })),
      );
    }

    // 步骤 8：更新最新版指针、最新版投影与草稿基线
    const projection: Record<string, unknown> = {
      title: content.title,
      description: content.description,
      samples: content.samples ?? [],
      latest_version_id: versionId,
      updated_at: now,
    };
    if (content.kind === "objective") {
      projection.runtime_config = null;
      projection.support_package_storage_url = null;
    } else if (content.kind === "oi") {
      projection.runtime_config = content.runtime_config;
      projection.support_package_storage_url = supportPackageUrl;
      projection.oi_data_files = oiDataFiles;
    } else {
      projection.runtime_config = content.runtime_config;
      projection.submission_mode = content.submission_mode;
      projection.template_content = content.template_content;
      projection.artifact_max_size_mb = content.artifact_max_size_mb;
      projection.llm_config = content.llm_config;
      projection.support_package_storage_url = supportPackageUrl;
    }
    await tx.update(problems).set(projection).where(
      eq(problems.id, problemId),
    );
    const nextDraftRevision = currentRevision + 1;
    if (draftRow) {
      await tx.update(problemDrafts).set({
        base_version_id: versionId,
        revision: nextDraftRevision,
        updated_at: now,
      }).where(eq(problemDrafts.problem_id, problemId));
    } else {
      await tx.insert(problemDrafts).values({
        problem_id: problemId,
        base_version_id: versionId,
        revision: nextDraftRevision,
        content: content as unknown as Record<string, unknown>,
        updated_by: input.actor.kind === "user" ? input.actor.userId : null,
        updated_at: now,
      });
    }

    // 步骤 9：审计与搜索索引随版本事务持久化（Handbook §5.3 第 9 步）。
    // 索引行与版本同事务写入：提交即已发布即可见，不会出现"已发布但索引永久缺失"。
    // 事务内只写 read-model 的表，不跨模块调用业务写入口。
    await writePublishAudit(tx, problemId, {
      version: nextVersion,
      versionId,
      changeNote: input.changeNote ?? "",
      actor: input.actor,
      now,
    });
    await recordPublishedBindingChanges(
      tx,
      problemId,
      versionId,
      input.actor.kind === "user" ? input.actor.userId : null,
      now,
    );
    await enqueueSearchIndexTaskTx(tx, "problem", problemId, "upsert");

    return {
      problem_id: problemId,
      version_id: versionId,
      version: nextVersion,
      draft_revision: nextDraftRevision,
      unchanged: false,
    };
  });

  // 提交后的 Redis 通知：索引已随事务持久化，通知只是缩短可见延迟；
  // 通知失败不再造成"永久缺索引"，可由 reindexAll 或下一次发布收敛。
  if (!outcome.unchanged) {
    await publishSearchIndexEvent("problem", problemId, "upsert");
  }
  return outcome;
}

/**
 * 在发布事务内写审计行（tracking #23）。
 *
 * 通过 platform 的 `appendAuditLogTx` 在同一事务内写入；操作者身份由调用方
 * 显式传入的 `UserActor`/`SystemActor` 决定，不再从 RequestContext/ALS 猜测，
 * 也不再把根连接当作可参与本事务的句柄。
 */
async function writePublishAudit(
  tx: DbTx,
  problemId: string,
  detail: {
    version: number;
    versionId: string;
    changeNote: string;
    actor: Actor;
    now: string;
  },
): Promise<void> {
  await appendAuditLogTx(tx, {
    actor: detail.actor,
    action: "problems.version_published",
    target: { type: "problem", id: problemId },
    detail: {
      action: "problems.version_published",
      version: detail.version,
      version_id: detail.versionId,
      change_note: detail.changeNote,
    },
    createdAt: detail.now,
  });
}

/**
 * 分页列出已发布版本元数据（新→旧）。
 */
export async function listProblemVersions(
  problemId: string,
  options: { page?: number; perPage?: number } = {},
): Promise<{ data: ProblemVersionSummary[]; total: number }> {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 20));
  const db = getDb();
  const [identity] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  ).limit(1);
  if (!identity) {
    throw new AppError(`题目不存在：${problemId}`, 404, "PROBLEM_NOT_FOUND");
  }
  const [countRow] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(problemVersions).where(eq(problemVersions.problem_id, problemId));
  const rows = await db.select().from(problemVersions).where(
    eq(problemVersions.problem_id, problemId),
  ).orderBy(sql`${problemVersions.version} DESC`).limit(perPage).offset(
    (page - 1) * perPage,
  );
  return {
    data: rows.map((row) => ({
      id: row.id,
      problem_id: row.problem_id,
      version: row.version,
      schema_version: row.schema_version,
      origin: row.origin,
      content_sha256: row.content_sha256,
      change_note: row.change_note,
      published_by: row.published_by,
      published_at: row.published_at,
      is_latest: row.id === identity.latest_version_id,
    })),
    total: countRow?.count ?? 0,
  };
}

/** 读取指定版本（必须属于该题）；不存在抛 404。 */
export async function getProblemVersionOrThrow(
  problemId: string,
  versionId: string,
): Promise<typeof problemVersions.$inferSelect> {
  const [row] = await getDb().select().from(problemVersions).where(
    and(
      eq(problemVersions.problem_id, problemId),
      eq(problemVersions.id, versionId),
    ),
  ).limit(1);
  if (!row) {
    throw new AppError(
      `题目版本不存在：${versionId}`,
      404,
      "PROBLEM_VERSION_NOT_FOUND",
    );
  }
  return row;
}

/** 列出某版本的不可变文件引用。 */
export async function listVersionObjects(
  versionId: string,
  executor?: Executor,
): Promise<DraftObjectRef[]> {
  const db = executor ?? getDb();
  const rows = await db.select().from(problemVersionObjects).where(
    eq(problemVersionObjects.version_id, versionId),
  );
  return rows
    .map((row) => ({
      role: row.role as DraftObjectRef["role"],
      path: row.path,
      storage_url: row.storage_url,
    }))
    .sort((a, b) =>
      a.role === b.role
        ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        : (a.role < b.role ? -1 : 1)
    );
}

/**
 * 解析题库「默认作答版本」并返回内容。
 *
 * `exact` 使用要求版本，`any` 使用最新版；题目尚未发布时返回 null
 * （普通访问者应得到 404，编辑者走草稿接口）。
 */
export async function resolveProblemAnswerVersion(
  problemId: string,
  problem?: typeof problems.$inferSelect,
): Promise<ProblemVersionContentView | null> {
  const identity = problem ?? await loadProblemIdentity(problemId);
  const [binding] = await getDb().select().from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.problem_id, problemId),
      eq(
        domainProblemBindings.domain_id,
        identity.domain_id ?? DEFAULT_DOMAIN_ID,
      ),
      eq(domainProblemBindings.kind, "owned"),
    ),
  );
  const mode = binding?.effective_version_mode ??
    identity.effective_version_mode;
  const required = binding
    ? binding.required_version_id
    : identity.required_version_id;
  const versionId = mode === "exact" ? required : identity.latest_version_id;
  if (!versionId) return null;
  const row = await getProblemVersionOrThrow(problemId, versionId);
  return {
    version_id: row.id,
    version: row.version,
    content: row.content as ProblemContentV1,
    is_latest: row.id === identity.latest_version_id,
  };
}
