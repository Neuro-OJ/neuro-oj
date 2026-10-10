/**
 * 提交时版本解析与校验（Handbook §4.2、§5.4 第 1 步）。
 *
 * 规则：
 * - **题库提交**：允许显式指定该题任意**已发布**版本；服务端校验版本属于该题
 *   （复合外键语义，避免 P12 的提交引用 P13 的版本）。
 * - **竞赛提交**：只接受该竞赛固定的作答版本，客户端覆盖一律
 *   `409 CONTEST_PROBLEM_VERSION_CHANGED`（保留客户端代码/答案并要求刷新）。
 * - 版本内容随提交参与校验：提交模式与语言必须被目标版本接受。
 *
 * 迁移期注意：`legacy_unknown`（无提交时版本）只应来自存量回填。新提交在客户端
 * 携带 `version_id` 后即走严格路径；未携带且题库已有已发布版本时返回
 * `VERSION_REQUIRED`，**绝不静默绑定最新版**。
 *
 * 竞赛分支的迁移期例外：竞赛题目已固定版本（`pinned_version_id` 非空）时，
 * 客户端未携带版本仍按**固定版本**作答（固定版本不会漂移到最新版，风险面仅限
 * "不知道自己在答哪一版"）；携带但与固定版本不一致仍一律 409。批次 7 存量收尾
 * 完成后，此处收紧为 `VERSION_REQUIRED`（与题库路径对齐）。
 */

import { and, eq } from "drizzle-orm";
import { AppError, BadRequestError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  contestProblems,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";

/** 解析结果：明确的提交时版本。 */
export interface ResolvedSubmissionVersion {
  version_id: string;
  version: number;
  content: ProblemContentV1;
  /** 是否为该题最新已发布版本（题库口径）。 */
  is_latest: boolean;
  /** 版本来源：客户端指定 / 竞赛固定版本。 */
  source: "requested" | "contest";
}

/** 客户端未携带版本且题库尚未发布任何版本（迁移期存量题目路径）。 */
export type SubmissionVersionResolution =
  | { kind: "known"; version: ResolvedSubmissionVersion }
  | { kind: "legacy_unknown" };

/** 409：竞赛固定版本与客户端携带版本不一致。 */
export function contestVersionChanged(
  expected: string | null,
  actual: string | null,
): AppError {
  return new AppError(
    "竞赛题目版本已变更，请刷新页面后重新提交（不会自动改用其他版本）",
    409,
    "CONTEST_PROBLEM_VERSION_CHANGED",
    { expected_version_id: expected, submitted_version_id: actual },
  );
}

/** 409：新客户端必须携带版本。 */
export function versionRequired(): AppError {
  return new AppError(
    "提交必须携带 version_id（题目已版本化，请升级客户端后重试）",
    409,
    "VERSION_REQUIRED",
  );
}

/** 404：指定版本不属于该题或尚未发布。 */
export function versionNotFound(versionId: string): AppError {
  return new AppError(
    `题目版本不存在或未发布：${versionId}`,
    404,
    "PROBLEM_VERSION_NOT_FOUND",
  );
}

/** 读取某题某版本的完整内容（必须已发布）。 */
export async function loadPublishedVersionContent(
  problemId: string,
  versionId: string,
  executor?: Executor,
): Promise<{ version: number; content: ProblemContentV1 } | null> {
  const db = executor ?? getDb();
  const [row] = await db.select({
    version: problemVersions.version,
    content: problemVersions.content,
    origin: problemVersions.origin,
  }).from(problemVersions).where(
    and(
      eq(problemVersions.problem_id, problemId),
      eq(problemVersions.id, versionId),
    ),
  ).limit(1);
  if (!row) return null;
  return {
    version: row.version,
    content: row.content as ProblemContentV1,
  };
}

/**
 * 校验提交模式与语言被目标版本接受。
 *
 * - AI 版本：提交模式必须与版本内容一致（code/artifact）；
 * - OI 版本：语言必须在版本的语言列表内（`LANGUAGE_NOT_SUPPORTED` 的判定点）。
 */
export function assertVersionAcceptsSubmission(
  content: ProblemContentV1,
  input: { language: string; submissionMode: "code" | "artifact" },
): void {
  if (content.kind === "ai") {
    if (content.submission_mode !== input.submissionMode) {
      throw new BadRequestError(
        `目标版本的提交模式为 ${content.submission_mode}，与本次提交不一致`,
      );
    }
    return;
  }
  if (content.kind === "oi") {
    if (!content.runtime_config.languages.includes(input.language as never)) {
      throw new BadRequestError(
        `目标版本不支持该语言：${input.language}`,
      );
    }
    return;
  }
  throw new BadRequestError("客观题版本不接受代码提交");
}

/**
 * 解析提交时版本。
 *
 * @param requestedVersionId 客户端携带的版本（竞赛提交下必须等于固定版本）
 */
export async function resolveSubmissionVersion(
  problemId: string,
  options: {
    contestId?: string | null;
    requestedVersionId?: string | null;
    /** 该题最新已发布版本；未提供时读取题目行。 */
    latestVersionId?: string | null;
  } = {},
  executor?: Executor,
): Promise<SubmissionVersionResolution> {
  const db = executor ?? getDb();
  const contestId = options.contestId ?? null;
  const requested = options.requestedVersionId?.trim() || null;

  let latestVersionId = options.latestVersionId;
  if (latestVersionId === undefined) {
    const [row] = await db.select({ latest: problems.latest_version_id })
      .from(problems).where(eq(problems.id, problemId)).limit(1);
    latestVersionId = row?.latest ?? null;
  }

  if (contestId) {
    const [contestProblem] = await db.select({
      pinned: contestProblems.pinned_version_id,
    }).from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    ).limit(1);
    if (!contestProblem) {
      throw new BadRequestError("该题目不属于此竞赛");
    }
    const pinned = contestProblem.pinned;
    // 迁移期：竞赛关联尚未固定版本时按存量路径处理（无已知提交时版本）
    if (!pinned) {
      if (requested) {
        throw versionNotFound(requested);
      }
      return { kind: "legacy_unknown" };
    }
    if (requested && requested !== pinned) {
      throw contestVersionChanged(pinned, requested);
    }
    const loaded = await loadPublishedVersionContent(problemId, pinned, db);
    if (!loaded) throw versionNotFound(pinned);
    return {
      kind: "known",
      version: {
        version_id: pinned,
        version: loaded.version,
        content: loaded.content,
        is_latest: pinned === latestVersionId,
        source: "contest",
      },
    };
  }

  if (requested) {
    const loaded = await loadPublishedVersionContent(problemId, requested, db);
    if (!loaded) throw versionNotFound(requested);
    return {
      kind: "known",
      version: {
        version_id: requested,
        version: loaded.version,
        content: loaded.content,
        is_latest: requested === latestVersionId,
        source: "requested",
      },
    };
  }

  // 未携带版本：题目已版本化则拒绝（不静默绑定最新版）；尚未发布任何版本的
  // 存量题目继续走 legacy_unknown，由迁移批次补齐。
  if (latestVersionId) {
    throw versionRequired();
  }
  return { kind: "legacy_unknown" };
}
