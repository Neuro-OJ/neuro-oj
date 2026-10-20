/**
 * 旧整题包入口固定 main，复用域导入的对象补偿与原子创建，保持稳定题目 ID。
 */
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../../../shared/base/errors.ts";
import {
  isValidProblemBundleName,
  validateBundleManifest,
} from "../../types/problem-bundle.ts";
import type { ProblemResponseWithTags } from "../../types/problems.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../../../domains/workspace/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../support-package.ts";
import {
  deriveDraftContentFromProblem,
  draftRevisionRequired,
  getProblemDraft,
  saveProblemDraft,
} from "../versioning/draft.ts";
import { publishProblemVersion } from "../versioning/publish.ts";
import { getProblem } from "./problems-list.ts";
import { importDomainProblemBundle } from "../workspace/problem-bundle-import.ts";
import { importDomainProblemDraftBundle } from "../workspace/problem-bundle-edit.ts";
import { parseBundleZip } from "../bundle-parser.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";

/**
 * 把当前题目投影（题面/配置/模板/客观题小题）同步进**共享草稿**。
 *
 * 导入流程是"写入者"：它先把内容落成题目投影，再调用本函数把同一份内容写进草稿，
 * 使 `--publish` 与后续编辑都以草稿为起点。客观题小题的 `key` 取旧小题 UUID
 * （与迁移基线规则一致，保证历史答案可按 key 匹配）。
 */
export async function syncProblemDraftFromProjection(
  problemId: string,
  actorId?: string | null,
): Promise<number> {
  const db = getDb();
  const [identity] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  ).limit(1);
  if (!identity) throw new BadRequestError("题目不存在");
  const content = await deriveDraftContentFromProblem(identity);
  const draft = await getProblemDraft(problemId, identity);
  const saved = await saveProblemDraft(problemId, {
    content,
    expectedRevision: draft.revision,
    actorId: actorId ?? null,
  });
  return saved.revision;
}

/**
 * 导入后显式发布当前内容为新版本（`problems import --publish`）。
 *
 * 内容事实源是**草稿**：编程题与客观题导入都直接写草稿（客观题小题 key 取
 * 现有/生成的 UUID），此处发布当前草稿 revision。相同内容重复发布返回既有版本
 * （`unchanged: true`），不制造空版本。
 */
export async function publishImportedProblem(
  problemId: string,
  actorId?: string | null,
  changeNote = "题目包导入",
): Promise<{ version_id: string; version: number; unchanged: boolean }> {
  await requireProblemById(problemId);
  const [identity] = await getDb().select().from(problems).where(
    eq(problems.id, problemId),
  );
  const revision = (await getProblemDraft(problemId, identity)).revision;
  const published = await publishProblemVersion(problemId, {
    expectedRevision: revision,
    changeNote,
    actorId: actorId ?? null,
  });
  return {
    version_id: published.version_id,
    version: published.version,
    unchanged: published.unchanged,
  };
}

/** 导入发布的显式用户合同；HTTP/application 不传入可空 actorId。 */
export function publishImportedProblemForActor(
  actor: UserActor,
  problemId: string,
  changeNote = "题目包导入",
) {
  return publishImportedProblem(problemId, actor.userId, changeNote);
}

/** 导入执行者（CLI 场景无 Hono Context）。 */
export interface BundleImportActor {
  /** 旧 CLI 适配器仍使用对象形状，但身份必须显式提供。 */
  userId: string;
  userRole?: string;
}

/**
 * 新的 HTTP/应用入口：题包导入只接收已认证的 UserActor 和显式 revision。
 * `expectedRevision` 缺省时，仅允许创建新题；按题号命中已有题目必须带 revision。
 */
export async function importProblemBundleForActor(
  file: { name: string; data: Uint8Array },
  actor: UserActor,
  expectedRevision?: number | "current",
  target?: { problemId: string; expectedRevision?: number | null },
): Promise<ProblemResponseWithTags & { warnings?: string[] }> {
  if (!isValidProblemBundleName(file.name)) {
    throw new ValidationError("仅支持 .zip 格式文件");
  }
  if (file.data.length > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new ValidationError(
      `导入包大小超过限制（最大 ${MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024}MB）`,
    );
  }
  const targetId = target?.problemId;
  let result;
  if (targetId) {
    await requireProblemById(targetId);
    const [identity] = await getDb().select({ number: problems.number }).from(
      problems,
    ).where(eq(problems.id, targetId));
    if (!identity) throw new NotFoundError("题目不存在");
    const revision = target.expectedRevision;
    if (revision == null) throw draftRevisionRequired();
    result = await importDomainProblemDraftBundle(
      DEFAULT_DOMAIN_SLUG,
      String(identity.number),
      actor,
      file.data,
      revision,
    );
  } else {
    const manifest = validateBundleManifest(parseBundleZip(file.data).manifest);
    let revision = expectedRevision;
    if (manifest.number !== undefined) {
      const [existing] = await getDb().select({ id: problems.id }).from(
        problems,
      ).where(and(
        eq(problems.domain_id, DEFAULT_DOMAIN_ID),
        eq(problems.number, manifest.number),
      ));
      if (existing && revision === undefined) throw draftRevisionRequired();
    }
    if (revision === undefined) revision = "current";
    result = await importDomainProblemBundle(
      DEFAULT_DOMAIN_SLUG,
      actor,
      file.data,
      revision,
    );
  }
  return { ...await getProblem(result.problem_id), warnings: result.warnings };
}

/** 旧上传接口不接受目标域，始终按 main 的实际角色及当前草稿授权。 */
export async function importProblemBundle(
  file: { name: string; data: Uint8Array },
  actor: BundleImportActor,
  c?: Context,
  target?: string | { problemId: string; expectedRevision?: number | null },
): Promise<ProblemResponseWithTags & { warnings?: string[] }> {
  if (!isValidProblemBundleName(file.name)) {
    throw new ValidationError("仅支持 .zip 格式文件");
  }
  if (file.data.length > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new ValidationError(
      `导入包大小超过限制（最大 ${MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024}MB）`,
    );
  }
  const actorId = actor.userId;
  const userActor = userActorFromAuthenticatedId(actorId);
  const targetId = typeof target === "string" ? target : target?.problemId;
  let result;
  if (targetId) {
    await requireProblemById(targetId);
    const [identity] = await getDb().select({ number: problems.number }).from(
      problems,
    ).where(eq(problems.id, targetId));
    const revision = typeof target === "string"
      ? undefined
      : target?.expectedRevision;
    if (revision == null) throw draftRevisionRequired();
    result = await importDomainProblemDraftBundle(
      DEFAULT_DOMAIN_SLUG,
      String(identity.number),
      userActor,
      file.data,
      revision,
    );
  } else {
    // 运维 CLI 明确采用当前草稿；HTTP 按题号更新仍必须提供编辑基线。
    let revision: number | "current" | undefined = c ? undefined : "current";
    const manifest = validateBundleManifest(parseBundleZip(file.data).manifest);
    if (c && manifest.number !== undefined) {
      const [existing] = await getDb().select({ id: problems.id }).from(
        problems,
      )
        .where(
          and(
            eq(problems.domain_id, DEFAULT_DOMAIN_ID),
            eq(problems.number, manifest.number),
          ),
        );
      if (existing) {
        const raw = c.req.header("if-match")?.trim().replace(/^W\//, "")
          .replace(/^"|"$/g, "");
        if (!raw) throw draftRevisionRequired();
        revision = Number(raw);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new BadRequestError("预期 revision 必须是非负整数");
        }
      }
    }
    result = await importDomainProblemBundle(
      DEFAULT_DOMAIN_SLUG,
      userActor,
      file.data,
      revision,
    );
  }
  return { ...await getProblem(result.problem_id), warnings: result.warnings };
}

/** 旧 CLI/HTTP 兼容入口仅能定位默认域源题。 */
export async function requireProblemById(id: string): Promise<void> {
  const [row] = await getDb().select({ id: problems.id }).from(problems)
    .where(and(eq(problems.id, id), eq(problems.domain_id, DEFAULT_DOMAIN_ID)));
  if (!row) throw new NotFoundError(`题目不存在：${id}`);
}

export { getProblem };
