import { and, asc, eq, inArray } from "drizzle-orm";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { DbTx, Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domains,
  problemDraftObjects,
  problemDrafts,
  problems,
  problemVersionObjects,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import {
  assertStorageObjectBindable,
  compensateUploadedObject,
  uploadStorageObjectWithReservation,
} from "../../../assets/contracts/cross-module/services_registry.ts";
import { getStorageProvider } from "../../../assets/storage/mod.ts";
import { listLlmGatewayModelCapabilities } from "../../../platform/contracts/cross-module/gateway_services_llm.ts";
import {
  computeProblemContentHash,
  type ProblemContentV1,
  validateProblemContent,
} from "../../types/problem-content.ts";
import { assertPublishedRuntimeSafety } from "../versioning/content-security.ts";
import {
  bindCreatedDomainProblem,
  prepareDomainProblemCreation,
} from "./problem-create.ts";
import {
  domainProblemReference,
  parseDomainProblemReference,
} from "./problem-reference.ts";
import { sha256Hex } from "../../../assets/storage/types.ts";
import { enqueueSearchIndexTaskTx } from "../../../application/search-tasks.ts";

async function sourceForCopy(
  slug: string,
  number: number,
  actorId: string,
  executor: Executor,
) {
  const access = await loadWorkspace(slug, actorId, { executor, write: true });
  const [source] = await executor.select().from(problems).where(and(
    eq(problems.domain_id, access.domain.id),
    eq(problems.number, number),
  ));
  if (!source?.latest_version_id) {
    throw new NotFoundError("源题尚未发布或不存在");
  }
  assertWorkspacePermission(
    access.context,
    access.context.domainPermissions.has("problem:write_any") ||
      source.owner_id !== actorId
      ? "problem:write_any"
      : "problem:write_own",
  );
  return { access, source };
}

/** 复制锁外预检结果；只在单次请求中使用，不充当授权缓存。 */
export interface PreparedProblemCopy {
  targetSlug: string;
  targetId: string;
  sourceSlug: string;
  sourceNumber: number;
  sourceId: string;
  versionId: string;
  actorId: string;
  content: ProblemContentV1;
  difficulty: string;
  objects: Array<
    {
      role: "support_package" | "oi_file";
      path: string;
      storage_url: string;
      sha256: string;
      size: number;
    }
  >;
}

/** 源管理权限和目标创建/发布权限同时成立才复制完整已发布版本及文件。 */
export async function prepareDomainProblemCopy(
  slug: string,
  sourceReference: string,
  actorId: string,
  versionId?: string,
): Promise<PreparedProblemCopy> {
  const parsed = parseDomainProblemReference(sourceReference);
  if (!parsed.sourceSlug || parsed.sourceSlug === slug) {
    throw new BadRequestError("复制须指定其他域的来源题号");
  }
  const db = getDb();
  const target = await loadWorkspace(slug, actorId, { write: true });
  assertWorkspacePermission(target.context, "problem:create");
  assertWorkspacePermission(target.context, "problem:publish");
  const { source } = await sourceForCopy(
    parsed.sourceSlug,
    parsed.number,
    actorId,
    db,
  );
  const [version] = await db.select().from(problemVersions).where(and(
    eq(problemVersions.problem_id, source.id),
    eq(problemVersions.id, versionId ?? source.latest_version_id!),
  ));
  if (!version) throw new NotFoundError("源题发布版本不存在");
  const content = structuredClone(version.content) as ProblemContentV1;
  // 只携带可移植的预算/别名声明，绝不继承 Provider、真实模型或密钥字段。
  if (content.kind === "ai" && content.llm_config) {
    const { max_calls, max_tokens, models } = content.llm_config;
    content.llm_config = { max_calls, max_tokens, models };
    const capabilities = await listLlmGatewayModelCapabilities(
      target.domain.id,
    );
    if (
      (models ?? ["default"]).some((alias) =>
        !capabilities.some((entry) => entry.alias === alias)
      )
    ) {
      throw new BadRequestError(
        "目标域尚未配置所需模型别名，请配置后重试",
        "COPY_TARGET_MODEL_UNAVAILABLE",
      );
    }
  }
  validateProblemContent(content.kind, content);
  await assertPublishedRuntimeSafety(content);
  const refs = await db.select().from(problemVersionObjects).where(
    eq(problemVersionObjects.version_id, version.id),
  );
  const objects: PreparedProblemCopy["objects"] = [];
  try {
    for (const ref of refs) {
      await assertStorageObjectBindable(ref.storage_url);
      const bytes = await (await getStorageProvider()).get(ref.storage_url);
      const uploaded = await uploadStorageObjectWithReservation({
        key: `domain-copy-${crypto.randomUUID()}`,
        bytes,
        contentType: "application/octet-stream",
        domainId: target.domain.id,
      });
      objects.push({
        role: ref.role,
        path: ref.path,
        storage_url: uploaded.storageUrl,
        sha256: await sha256Hex(bytes),
        size: bytes.byteLength,
      });
    }
    return {
      targetSlug: slug,
      targetId: target.domain.id,
      sourceSlug: parsed.sourceSlug,
      sourceNumber: parsed.number,
      sourceId: source.id,
      versionId: version.id,
      actorId,
      content,
      difficulty: source.difficulty,
      objects,
    };
  } catch (error) {
    await Promise.allSettled(
      objects.map((ref) =>
        compensateUploadedObject({ storageUrl: ref.storage_url })
      ),
    );
    throw error;
  }
}

/** 在最终事务中重查双方权限并原子发布新身份；无源绑定、历史成绩和隐式授权。 */
export async function commitDomainProblemCopy(
  tx: DbTx,
  prepared: PreparedProblemCopy,
) {
  await tx.select({ id: domains.id }).from(domains).where(
    inArray(domains.slug, [prepared.sourceSlug, prepared.targetSlug]),
  ).orderBy(asc(domains.id)).for("update");
  const { source } = await sourceForCopy(
    prepared.sourceSlug,
    prepared.sourceNumber,
    prepared.actorId,
    tx,
  );
  if (source.id !== prepared.sourceId) {
    throw new ConflictError("源题身份已变化，请重新复制");
  }
  const [version] = await tx.select({ id: problemVersions.id }).from(
    problemVersions,
  ).where(and(
    eq(problemVersions.id, prepared.versionId),
    eq(problemVersions.problem_id, source.id),
  )).for("share");
  if (!version) throw new NotFoundError("源题版本已移除，请重新复制");
  const access = await loadWorkspace(prepared.targetSlug, prepared.actorId, {
    executor: tx,
    write: true,
  });
  assertWorkspacePermission(access.context, "problem:publish");
  const creation = await prepareDomainProblemCreation(
    prepared.targetSlug,
    prepared.actorId,
    undefined,
    tx,
  );
  if (creation.domain.id !== prepared.targetId) {
    throw new ConflictError("目标域已变化");
  }
  const content = prepared.content;
  for (const ref of prepared.objects) {
    await assertStorageObjectBindable(ref.storage_url, tx);
  }
  const id = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    now = new Date().toISOString();
  const [problem] = await tx.insert(problems).values({
    id,
    domain_id: access.domain.id,
    number: creation.number,
    owner_id: prepared.actorId,
    title: content.title,
    description: content.description,
    samples: content.samples,
    difficulty: prepared.difficulty,
    visibility: "public",
    is_objective: content.kind === "objective",
    judge_type: content.kind === "oi" ? "oi" : "dual",
    submission_mode: content.kind === "ai" ? content.submission_mode : "code",
    runtime_config: content.kind === "objective"
      ? null
      : content.runtime_config,
    template_content: content.kind === "ai" ? content.template_content : "",
    artifact_max_size_mb: content.kind === "ai"
      ? content.artifact_max_size_mb
      : null,
    llm_config: content.kind === "ai" ? content.llm_config : null,
    oi_data_files: content.kind === "oi"
      ? Object.fromEntries(
        prepared.objects
          .filter((ref) => ref.role === "oi_file").map((ref) => [ref.path, {
            storage_url: ref.storage_url,
            size: ref.size,
            hash: ref.sha256,
          }]),
      )
      : null,
    support_package_storage_url: prepared.objects.find((ref) =>
      ref.role === "support_package"
    )?.storage_url ?? null,
    created_at: now,
    updated_at: now,
  }).returning();
  await tx.insert(problemVersions).values({
    id: versionId,
    problem_id: id,
    version: 1,
    content,
    content_sha256: await computeProblemContentHash(content, prepared.objects),
    published_by: prepared.actorId,
    published_at: now,
    change_note: "跨域复制的独立发布版本",
  });
  if (prepared.objects.length) {
    await tx.insert(problemVersionObjects).values(
      prepared.objects.map(({ role, path, storage_url }) => ({
        role,
        path,
        storage_url,
        version_id: versionId,
      })),
    );
    await tx.insert(problemDraftObjects).values(
      prepared.objects.map(({ role, path, storage_url }) => ({
        role,
        path,
        storage_url,
        problem_id: id,
      })),
    );
  }
  await tx.insert(problemDrafts).values({
    problem_id: id,
    base_version_id: versionId,
    content,
    updated_by: prepared.actorId,
    updated_at: now,
  });
  await tx.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, id),
  );
  await bindCreatedDomainProblem(
    problem,
    access.domain.id,
    prepared.actorId,
    creation.used,
    tx,
  );
  const [binding] = await tx.select().from(domainProblemBindings)
    .where(
      and(
        eq(domainProblemBindings.problem_id, id),
        eq(domainProblemBindings.domain_id, access.domain.id),
      ),
    );
  await enqueueSearchIndexTaskTx(tx, "problem", id, "upsert", versionId);
  await workspaceAudit(
    tx,
    prepared.actorId,
    access.domain.id,
    "domain.update",
    {
      operation: "problem.copy",
      problem_id: id,
      source_problem_id: source.id,
      source_version_id: prepared.versionId,
    },
  );
  return {
    binding,
    reference: domainProblemReference(
      problem,
      access.domain.slug,
      access.domain.id,
    ),
    version_id: versionId,
  };
}

/** 失败只补偿本次上传，已被其他题目引用的对象由登记层保留。 */
export async function compensateProblemCopy(prepared: PreparedProblemCopy) {
  await Promise.allSettled(
    prepared.objects.map((ref) =>
      compensateUploadedObject({ storageUrl: ref.storage_url })
    ),
  );
}
