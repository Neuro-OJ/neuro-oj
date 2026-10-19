import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { problemVersions } from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import type { AnnotationTarget } from "../../../shared/annotation-types.ts";
import { annotationIsPlainText } from "../../../shared/annotation-types.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import {
  resolveDomainProblem,
  trimProblemContentForViewer,
} from "../../catalog/index.ts";
import type { ProblemContentV1 } from "../../catalog/index.ts";
import {
  getDomainSubmission,
  readDomainSubmissionText,
} from "../../submission/index.ts";
import {
  getPost,
  resolvePostId,
  withDomainCommunity,
} from "../../community/index.ts";
import { annotationBlocks, annotationHash } from "./text.ts";

/** 外部目标只接受明确的三种原文和受限字段，不能把评测配置当作题面。 */
export function parseAnnotationTarget(value: unknown): AnnotationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("需要批注原文对象");
  }
  const v = value as Record<string, unknown>;
  const text = (key: string, max = 4096) => {
    if (
      typeof v[key] !== "string" || !v[key] || (v[key] as string).length > max
    ) throw new BadRequestError("批注原文标识无效");
    return v[key] as string;
  };
  if (v.kind === "submission") {
    return {
      kind: "submission",
      submission_id: text("submission_id", 100),
      file_name: text("file_name"),
    };
  }
  if (v.kind === "solution") {
    return { kind: "solution", post_id: text("post_id", 100) };
  }
  if (v.kind === "problem") {
    const field = text("field", 200);
    if (
      !/^(description|title|samples\.\d+\.(input|output|explanation)|questions\.\d+\.(prompt|options\.\d+\.(text|label)))$/
        .test(field)
    ) throw new BadRequestError("此字段不是可批注的公开题面");
    return {
      kind: "problem",
      reference: text("reference", 100),
      field,
      ...(v.version_id === undefined
        ? {}
        : { version_id: text("version_id", 100) }),
      ...(v.contest_id === undefined
        ? {}
        : { contest_id: text("contest_id", 100) }),
    };
  }
  throw new BadRequestError("不支持此批注原文类型");
}

/** 重新授权原文；读取历史批注时也不能跳过当前共享、题解或源码限制。 */
export async function loadAnnotationTarget(
  slug: string,
  actorId: string,
  input: AnnotationTarget,
  content = true,
  governance = false,
) {
  const target = parseAnnotationTarget(input),
    workspace = await loadWorkspace(slug, actorId);
  if (!workspace.membership && !(governance && workspace.platformAdmin)) {
    throw new NotFoundError("批注需要当前域有效成员身份");
  }
  if (target.kind === "problem") {
    const resolved = await resolveDomainProblem(
      slug,
      target.reference,
      actorId,
      { contestId: target.contest_id },
    );
    const versionId = target.version_id ?? resolved.version.id;
    if (target.contest_id && versionId !== resolved.version.id) {
      throw new NotFoundError("不是当前比赛题目版本");
    }
    const [version] = await getDb().select().from(problemVersions).where(
      and(
        eq(problemVersions.id, versionId),
        eq(problemVersions.problem_id, resolved.problem.id),
      ),
    );
    if (!version) throw new NotFoundError("题目版本不存在");
    const visible = trimProblemContentForViewer(
      version.content as ProblemContentV1,
      false,
    );
    let field: unknown = visible;
    for (const key of target.field.split(".")) {
      field = field && typeof field === "object"
        ? (field as Record<string, unknown>)[key]
        : undefined;
    }
    if (typeof field !== "string") {
      throw new NotFoundError("题面字段不存在或不可访问");
    }
    return {
      workspace,
      target: {
        ...target,
        reference: resolved.reference.qualified_ref,
        version_id: version.id,
      },
      target_key:
        `problem:${resolved.problem.id}:${version.id}:${target.field}:${
          target.contest_id ?? "practice"
        }`,
      content: field,
      student_id: null,
      href: `/d/${slug}/problems/${
        encodeURIComponent(resolved.reference.display_ref)
      }`,
    };
  }
  if (target.kind === "solution") {
    const id = await resolvePostId(target.post_id);
    const row = await withDomainCommunity(
      slug,
      actorId,
      {},
      (scope) => getPost(id, actorId, scope.moderator, scope),
    );
    if (row.post.type !== "solution") {
      throw new NotFoundError("不是可批注的题解");
    }
    return {
      workspace,
      target: { kind: "solution" as const, post_id: id },
      target_key: `solution:${id}`,
      content: row.post.content,
      student_id: null,
      href: `/d/${slug}/community/posts/${row.post.public_id || id}`,
    };
  }
  if (content) {
    const file = await readDomainSubmissionText(
      slug,
      actorId,
      target.submission_id,
      target.file_name,
    );
    return {
      workspace,
      target: { ...target, submission_id: file.id },
      target_key: `submission:${file.id}:${target.file_name}`,
      content: file.content,
      student_id: file.user_id,
      href: `/d/${slug}/submissions/${file.public_id || file.id}`,
    };
  }
  const visible = await getDomainSubmission(
    slug,
    target.submission_id,
    actorId,
  );
  if (!visible.can_view_source || !visible.resource_available) {
    throw new NotFoundError("提交原文不存在或不可访问");
  }
  const id = String(visible.id);
  return {
    workspace,
    target: { ...target, submission_id: id },
    target_key: `submission:${id}:${target.file_name}`,
    content: "",
    student_id: String(visible.user_id),
    href: `/d/${slug}/submissions/${visible.public_id || id}`,
  };
}

/** 创建选区与预览使用同一份规范化原文和指纹。 */
export async function getAnnotationSource(
  slug: string,
  actorId: string,
  target: AnnotationTarget,
) {
  const source = await loadAnnotationTarget(slug, actorId, target);
  if (new TextEncoder().encode(source.content).length > 1024 * 1024) {
    throw new BadRequestError("在线批注原文不能超过 1 MiB");
  }
  return {
    target: source.target,
    target_key: source.target_key,
    content_hash: await annotationHash(source.content),
    blocks: annotationBlocks(
      source.content,
      annotationIsPlainText(source.target),
    ),
    student_id: source.student_id,
    href: source.href,
  };
}
