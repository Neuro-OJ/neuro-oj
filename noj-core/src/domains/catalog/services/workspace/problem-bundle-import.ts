import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../workspace/index.ts";
import {
  compensateUploadedObject,
  uploadStorageObjectWithReservation,
} from "../../../system/index.ts";
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
import { createDomainProblem } from "../problems/problems-crud.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "../problems/problem-field-guard.ts";
import { assertPublishedRuntimeSafety } from "../versioning/content-security.ts";
import {
  type DraftObjectRef,
  draftRevisionRequired,
} from "../versioning/draft.ts";
import { stripMetadataEntries } from "../bundle-parser.ts";
import { getTagIdsByNames } from "../tags.ts";
import { isOiRuntimeConfig } from "../../types/runtime-config.ts";
import { readDomainProblemDraft } from "./problem-edit.ts";
import {
  importDomainProblemDraftBundle,
  parseDomainDraftBundle,
} from "./problem-bundle-edit.ts";

/** 域内指定题号导入更新已有草稿，否则新建；内容、对象与绑定在同一创建事务。 */
export async function importDomainProblemBundle(
  slug: string,
  actorId: string,
  bytes: Uint8Array,
  expectedRevision?: number | "current",
  context?: Context,
) {
  const workspace = await loadWorkspace(slug, actorId, { write: true });
  assertWorkspacePermission(workspace.context, "problem:create");
  const { manifest, content, parsed } = parseDomainDraftBundle(bytes);
  if (manifest.number !== undefined) {
    const [existing] = await getDb().select({ number: problems.number }).from(
      problems,
    ).where(and(
      eq(problems.domain_id, workspace.domain.id),
      eq(problems.number, manifest.number),
    ));
    if (existing) {
      if (expectedRevision === undefined) throw draftRevisionRequired();
      const revision = expectedRevision === "current"
        ? (await readDomainProblemDraft(slug, String(existing.number), actorId))
          .revision
        : expectedRevision;
      const saved = await importDomainProblemDraftBundle(
        slug,
        String(existing.number),
        actorId,
        bytes,
        revision,
        context,
      );
      return {
        ...saved,
        number: existing.number,
        created: false,
        warnings: parsed.warnings,
      };
    }
  }
  const runtime = manifest.runtime_config;
  if (runtime) {
    await assertSensitiveFieldPermissions(context, actorId, undefined, runtime);
    enforceResourceLimits(runtime);
  }
  if (manifest.llm) assertLlmLimitsWithinDefault(manifest.llm);
  await assertPublishedRuntimeSafety(content);
  const objects: DraftObjectRef[] = [];
  try {
    // OI 逐文件引用让首次导入后即能用文件编辑器；源包字节只属于此域。
    if (runtime && isOiRuntimeConfig(runtime)) {
      for (const [path, file] of Object.entries(parsed.entries)) {
        if (
          [
            "problem.json",
            "statement.md",
            "problem.yaml",
            "problem.md",
            "problem_zh.md",
          ].includes(path) || path.endsWith("/")
        ) continue;
        const uploaded = await uploadStorageObjectWithReservation({
          key: `domain-oi-${crypto.randomUUID()}`,
          bytes: file,
          contentType: "application/octet-stream",
          domainId: workspace.domain.id,
        });
        objects.push({
          role: "oi_file",
          path,
          storage_url: uploaded.storageUrl,
        });
      }
    }
    if (content.kind !== "objective") {
      const uploaded = await uploadStorageObjectWithReservation({
        key: `domain-bundle-${crypto.randomUUID()}.zip`,
        bytes: stripMetadataEntries(bytes),
        contentType: "application/zip",
        domainId: workspace.domain.id,
      });
      objects.push({
        role: "support_package",
        path: "package.zip",
        storage_url: uploaded.storageUrl,
      });
    }
    const problem = await createDomainProblem(
      slug,
      {
        title: content.title,
        description: content.description,
        samples: content.samples,
        number: manifest.number,
        difficulty: manifest.difficulty,
        visibility: workspace.domain.configuration.access === "public"
          ? "public"
          : "private",
        runtime_config: runtime,
        is_objective: manifest.is_objective,
        judge_type: manifest.judge_type,
        submission_mode: content.kind === "ai"
          ? manifest.submission_mode as "code" | "artifact" | undefined
          : "code",
        artifact_max_size_mb: manifest.artifact_max_size_mb,
        llm: manifest.llm,
        tag_ids: await getTagIdsByNames(manifest.tags ?? []),
      },
      actorId,
      context,
      { content, objects },
    );
    return {
      problem_id: problem.id,
      number: problem.number,
      draft_revision: 1,
      created: true,
      warnings: parsed.warnings,
    };
  } catch (error) {
    await Promise.allSettled(
      objects.map((object) =>
        compensateUploadedObject({ storageUrl: object.storage_url })
      ),
    );
    throw error;
  }
}
