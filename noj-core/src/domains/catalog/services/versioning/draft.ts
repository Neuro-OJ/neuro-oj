/**
 * 题目共享草稿服务（Handbook §2.4、§5.2）。
 *
 * - 每题一个共享草稿，权限沿用题目编辑权限（路由层校验）；
 * - 编辑、上传文件、增删客观题小题都递增**同一个** `revision`；
 * - 所有修改必须校验预期 revision（缺失 → 428，过时 → 409）；
 * - 草稿允许暂时不完整；发布时才做完整性校验；
 * - 保存草稿**不**推送 Judge、不改有效策略、不刷新公开题目内容。
 *
 * revision 语义：`0` 表示"尚未保存过草稿"（内容由最新版投影派生），
 * 每次成功保存写入 `当前 revision + 1`，与列默认值 1 对齐。
 */

import { and, eq, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  objectiveQuestions,
  problemDraftObjects,
  problemDrafts,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import type { ProblemObjectRole } from "../../../../shared/versioning/types.ts";
import type {
  ProblemContentKind,
  ProblemDraftContent,
} from "../../types/problem-content.ts";
import { problemContentKindOf } from "../../types/problem-content.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { assertStorageObjectBindable } from "../../../system/services/storage/registry.ts";

/** 未保存过草稿时的虚拟 revision。 */
export const PROBLEM_DRAFT_VIRTUAL_REVISION = 0;

/** 草稿视图。 */
export interface ProblemDraftView {
  problem_id: string;
  base_version_id: string | null;
  revision: number;
  content: ProblemDraftContent;
  updated_by: string | null;
  updated_at: string | null;
  /** true = 数据库中没有草稿行，内容由最新版/题目投影派生。 */
  synthesized: boolean;
}

/** 题目身份行（草稿派生只需要这几列）。 */
export type ProblemIdentityRow = typeof problems.$inferSelect;

/** 428：写草稿缺少预期 revision。 */
export function draftRevisionRequired(): AppError {
  return new AppError(
    "保存草稿必须携带 If-Match: <revision>（缺少预期 revision）",
    428,
    "DRAFT_REVISION_REQUIRED",
  );
}

/** 409：预期 revision 已过时。 */
export function draftRevisionConflict(
  expected: number,
  actual: number,
): AppError {
  return new AppError(
    `草稿已被其他编辑更新（预期 revision ${expected}，当前 ${actual}）`,
    409,
    "DRAFT_REVISION_CONFLICT",
  );
}

/** 409：草稿基线已不是最新版（其他人已发布）。 */
export function draftBaselineConflict(): AppError {
  return new AppError(
    "草稿基线已不是最新版：请刷新草稿后重新发布",
    409,
    "DRAFT_BASELINE_CONFLICT",
  );
}

/** 读取题目身份行；不存在抛 404。 */
export async function loadProblemIdentity(
  problemId: string,
): Promise<ProblemIdentityRow> {
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, problemId),
  ).limit(1);
  if (!row) {
    throw new AppError(`题目不存在：${problemId}`, 404, "PROBLEM_NOT_FOUND");
  }
  return row;
}

/**
 * 从题目行 + 当前客观题小题派生草稿内容。
 *
 * 这是**迁移期**的派生路径：客观题小题尚未迁入版本快照前，草稿初值只能来自
 * 现有 `objective_questions` 表；迁移完成后该表退役，派生来源改为最新版内容。
 */
export async function deriveDraftContentFromProblem(
  problem: ProblemIdentityRow,
): Promise<ProblemDraftContent> {
  const kind = problemContentKindOf(problem);
  const base = {
    kind,
    title: problem.title,
    description: problem.description,
    samples: (problem.samples as ProblemDraftContent["samples"]) ?? [],
  } as ProblemDraftContent;

  if (kind === "objective") {
    const questions = await getDb().select().from(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, problem.id),
    ).orderBy(objectiveQuestions.sort_order);
    return {
      ...base,
      questions: questions.map((question) => ({
        // 迁移规则：现有小题 UUID 直接作为稳定 key
        key: question.id,
        sort_order: question.sort_order,
        type: question.type,
        prompt: question.prompt,
        options: question.options,
        answer: question.answer,
        explanation: question.explanation,
      })),
    };
  }

  if (kind === "oi") {
    return { ...base, runtime_config: problem.runtime_config };
  }

  return {
    ...base,
    submission_mode: problem.submission_mode,
    runtime_config: problem.runtime_config,
    template_content: problem.template_content ?? "",
    artifact_max_size_mb: problem.artifact_max_size_mb,
    llm_config: problem.llm_config,
  };
}

/**
 * 读取共享草稿。
 *
 * 没有草稿行时返回**派生初值**（基于最新版内容，其次题目投影），
 * `revision = 0`、`synthesized = true`；不写库。
 */
export async function getProblemDraft(
  problemId: string,
  problem?: ProblemIdentityRow,
): Promise<ProblemDraftView> {
  const identity = problem ?? await loadProblemIdentity(problemId);
  const [row] = await getDb().select().from(problemDrafts).where(
    eq(problemDrafts.problem_id, problemId),
  ).limit(1);

  if (row) {
    return {
      problem_id: row.problem_id,
      base_version_id: row.base_version_id,
      revision: row.revision,
      content: row.content as ProblemDraftContent,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      synthesized: false,
    };
  }

  // 派生：优先最新版内容（内容事实源），否则退回题目行投影
  let content: ProblemDraftContent;
  if (identity.latest_version_id) {
    const [version] = await getDb().select().from(problemVersions).where(
      and(
        eq(problemVersions.problem_id, problemId),
        eq(problemVersions.id, identity.latest_version_id),
      ),
    ).limit(1);
    content = version
      ? version.content as ProblemDraftContent
      : await deriveDraftContentFromProblem(identity);
  } else {
    content = await deriveDraftContentFromProblem(identity);
  }

  return {
    problem_id: problemId,
    base_version_id: identity.latest_version_id,
    revision: PROBLEM_DRAFT_VIRTUAL_REVISION,
    content,
    updated_by: null,
    updated_at: null,
    synthesized: true,
  };
}

/**
 * 保存共享草稿（乐观锁）。
 *
 * @throws {AppError} 428 缺少预期 revision；409 revision 过时；400 类别不可变
 */
export async function saveProblemDraft(
  problemId: string,
  input: {
    content: ProblemDraftContent;
    expectedRevision: number | null | undefined;
    actorId: string | null;
  },
): Promise<ProblemDraftView> {
  if (input.expectedRevision == null) throw draftRevisionRequired();
  const expected = Number(input.expectedRevision);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new AppError("预期 revision 必须是非负整数", 400, "INVALID_REVISION");
  }

  const db = getDb();
  const identity = await loadProblemIdentity(problemId);
  const kind: ProblemContentKind = problemContentKindOf(identity);
  if (input.content?.kind !== kind) {
    throw new AppError(
      `题目内容类别不可变：期望 ${kind}，实际 ${String(input.content?.kind)}`,
      400,
      "CONTENT_KIND_IMMUTABLE",
    );
  }

  return await db.transaction(async (tx) => {
    // 锁定题目行：串行化同一题的草稿编辑与发布，防止 revision 丢失
    await tx.execute(
      sql`SELECT id FROM problems WHERE id = ${problemId} FOR UPDATE`,
    );
    const [row] = await tx.select().from(problemDrafts).where(
      eq(problemDrafts.problem_id, problemId),
    ).limit(1);
    const current = row?.revision ?? PROBLEM_DRAFT_VIRTUAL_REVISION;
    if (current !== expected) throw draftRevisionConflict(expected, current);

    const now = new Date().toISOString();
    const nextRevision = current + 1;
    const baseVersionId = row?.base_version_id ?? identity.latest_version_id;

    if (row) {
      await tx.update(problemDrafts).set({
        content: input.content,
        revision: nextRevision,
        base_version_id: baseVersionId,
        updated_by: input.actorId,
        updated_at: now,
      }).where(eq(problemDrafts.problem_id, problemId));
    } else {
      await tx.insert(problemDrafts).values({
        problem_id: problemId,
        base_version_id: baseVersionId,
        revision: nextRevision,
        content: input.content,
        updated_by: input.actorId,
        updated_at: now,
      });
    }

    return {
      problem_id: problemId,
      base_version_id: baseVersionId,
      revision: nextRevision,
      content: input.content,
      updated_by: input.actorId,
      updated_at: now,
      synthesized: false,
    };
  });
}

/** 草稿文件引用行。 */
export interface DraftObjectRef {
  role: ProblemObjectRole;
  path: string;
  storage_url: string;
}

/** 列出草稿的全部文件引用（按 role、path 排序）。 */
export async function listDraftObjects(
  problemId: string,
): Promise<DraftObjectRef[]> {
  const rows = await getDb().select().from(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, problemId),
  );
  return rows
    .map((row) => ({
      role: row.role as ProblemObjectRole,
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
 * 设置草稿文件引用（upsert）。
 *
 * 绑定前必须确认对象未进入删除流程（`assertStorageObjectBindable`）：
 * 新引用不能绑定 `deleting` / `deleted` 对象。
 */
export async function setDraftObject(
  problemId: string,
  ref: DraftObjectRef,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? getDb();
  await assertStorageObjectBindable(ref.storage_url, executor);
  await db.insert(problemDraftObjects).values({
    problem_id: problemId,
    role: ref.role,
    path: ref.path,
    storage_url: ref.storage_url,
  }).onConflictDoUpdate({
    target: [
      problemDraftObjects.problem_id,
      problemDraftObjects.role,
      problemDraftObjects.path,
    ],
    set: { storage_url: ref.storage_url },
  });
}

/** 删除草稿文件引用（幂等）。 */
export async function removeDraftObject(
  problemId: string,
  role: ProblemObjectRole,
  path: string,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? getDb();
  await db.delete(problemDraftObjects).where(
    and(
      eq(problemDraftObjects.problem_id, problemId),
      eq(problemDraftObjects.role, role),
      eq(problemDraftObjects.path, path),
    ),
  );
}

/**
 * 替换草稿中某 role 下的全部引用（支持包用固定逻辑路径 `package.zip`）。
 *
 * 返回被移除的旧引用，供上传补偿判断是否需要回收对象。
 */
export async function replaceDraftObjectsForRole(
  problemId: string,
  role: ProblemObjectRole,
  refs: readonly { path: string; storage_url: string }[],
  executor?: Executor,
): Promise<DraftObjectRef[]> {
  const db = executor ?? getDb();
  const existing = await db.select().from(problemDraftObjects).where(
    and(
      eq(problemDraftObjects.problem_id, problemId),
      eq(problemDraftObjects.role, role),
    ),
  );
  const keep = new Set(refs.map((ref) => ref.path));
  for (const row of existing) {
    if (!keep.has(row.path)) {
      await removeDraftObject(problemId, role, row.path, executor);
    }
  }
  for (const ref of refs) {
    await setDraftObject(problemId, {
      role,
      path: ref.path,
      storage_url: ref.storage_url,
    }, executor);
  }
  return existing.map((row) => ({
    role: row.role as ProblemObjectRole,
    path: row.path,
    storage_url: row.storage_url,
  }));
}
