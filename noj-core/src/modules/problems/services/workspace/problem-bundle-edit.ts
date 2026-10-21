import {
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  compensateUploadedObject,
  uploadStorageObjectWithReservation,
} from "../../../assets/contracts/cross-module/services_registry.ts";
import { judgeOptions } from "../objective/objective-questions.ts";
import {
  parseBundleZip,
  readBundleTemplate,
  readBundleUi,
  stripMetadataEntries,
} from "../bundle-parser.ts";
import {
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../types/problem-bundle.ts";
import {
  type ProblemDraftContent,
  validateProblemContent,
} from "../../types/problem-content.ts";
import {
  draftRevisionConflict,
  getProblemDraft,
  saveProblemDraftWithObjects,
} from "../versioning/draft.ts";
import {
  assertDraftContentSecurity,
  assertPublishedRuntimeSafety,
} from "../versioning/content-security.ts";
import { saveOiDraft } from "../versioning/oi-draft.ts";
import { loadEditableDomainProblem } from "./problem-edit.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";

/** 题包只替换显式使用域源题的草稿；题号、归属与发布状态由路径决定。 */
export async function importDomainProblemDraftBundle(
  slug: string,
  reference: string,
  actor: UserActor,
  bytes: Uint8Array,
  expectedRevision: number,
) {
  const access = await loadEditableDomainProblem(slug, reference, actor);
  const draft = await getProblemDraft(access.problem.id, access.problem);
  if (draft.revision !== expectedRevision) {
    throw draftRevisionConflict(expectedRevision, draft.revision);
  }
  const { parsed, manifest, content } = parseDomainDraftBundle(bytes);
  // 类型与平台敏感配置先验证，不能上传成功后才发现目标源题不匹配。
  const kind = access.problem.is_objective
    ? "objective"
    : access.problem.judge_type === "oi"
    ? "oi"
    : "ai";
  if (content.kind !== kind) {
    throw new ConflictError("题目类型不能修改", "CONTENT_KIND_IMMUTABLE");
  }
  validateProblemContent(kind, content);
  await assertDraftContentSecurity(access.problem, content, actor.userId);
  await assertPublishedRuntimeSafety(content);
  const authorize = async (tx: Executor) => {
    await loadEditableDomainProblem(slug, reference, actor, {
      executor: tx,
      write: true,
    });
  };
  if (content.kind === "oi") {
    const entries = { ...parsed.entries };
    for (
      const name of [
        "problem.json",
        "statement.md",
        "problem.yaml",
        "problem.md",
        "problem_zh.md",
      ]
    ) {
      delete entries[name];
    }
    const saved = await saveOiDraft(access.problem.id, {
      title: content.title,
      description: content.description,
      samples: content.samples,
      runtime_config: manifest.runtime_config,
      expectedRevision,
      actorId: actor.userId,
      authorize,
      domainId: access.domain.id,
    }, entries);
    return {
      problem_id: saved.problem_id,
      draft_revision: saved.revision,
      warnings: parsed.warnings,
    };
  }
  let storageUrl: string | undefined;
  try {
    if (content.kind === "ai") {
      storageUrl = (await uploadStorageObjectWithReservation({
        key: `domain-problem-${access.problem.id}-${crypto.randomUUID()}.zip`,
        bytes: stripMetadataEntries(bytes),
        contentType: "application/zip",
        domainId: access.domain.id,
      })).storageUrl;
    }
    const saved = await getDb().transaction(async (tx) => {
      await authorize(tx);
      return await saveProblemDraftWithObjects(access.problem.id, {
        content,
        expectedRevision,
        actorId: actor.userId,
        objects: storageUrl
          ? [{
            role: "support_package",
            path: "package.zip",
            storage_url: storageUrl,
          }]
          : [],
      }, tx);
    });
    return {
      problem_id: saved.problem_id,
      draft_revision: saved.revision,
      warnings: parsed.warnings,
    };
  } catch (error) {
    if (storageUrl) await compensateUploadedObject({ storageUrl });
    throw error;
  }
}

/** HTTP 编辑与容器 CLI 共用题包内容规范化，部署 Domain 不写进 manifest。 */
export function parseDomainDraftBundle(bytes: Uint8Array) {
  const parsed = parseBundleZip(bytes);
  const manifest = validateBundleManifest(parsed.manifest);
  const base = {
    title: manifest.title,
    description: parsed.statement ?? manifest.description ?? "",
    samples: manifest.samples ?? [],
  };
  if (!base.description.trim()) throw new BadRequestError("题包缺少题面");
  let content: ProblemDraftContent;
  if (manifest.is_objective) {
    content = {
      ...base,
      kind: "objective",
      questions: validateObjectiveQuestions(parsed.questions).map((
        question,
      ) => ({
        ...question,
        key: question.key ?? crypto.randomUUID(),
        options: question.type === "judge" ? judgeOptions : question.options,
        explanation: question.explanation ?? "",
      })),
    };
  } else if (manifest.judge_type === "oi") {
    content = { ...base, kind: "oi", runtime_config: manifest.runtime_config };
  } else {
    const template = readBundleTemplate(parsed.entries, manifest.template);
    if (template.status === "too_large") {
      throw new BadRequestError("题包模板超过大小限制");
    }
    if (manifest.submission_mode === "ui") {
      const ui = readBundleUi(parsed.entries);
      if (ui.status === "missing") {
        throw new BadRequestError("界面题包缺少 ui.html");
      }
      if (ui.status === "too_large") {
        throw new BadRequestError("ui.html 超过大小限制");
      }
    }
    content = {
      ...base,
      kind: "ai",
      runtime_config: manifest.runtime_config,
      submission_mode: manifest.submission_mode ?? "code",
      artifact_max_size_mb: manifest.artifact_max_size_mb ?? null,
      template_content: template.status === "ok" ? template.content : "",
      llm_config: manifest.llm ?? null,
    };
  }
  validateProblemContent(content.kind, content);
  return { parsed, manifest, content };
}
