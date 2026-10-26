import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { contestProblems } from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import {
  getJudgeBackend,
  getSubmissionLanguages,
  isValidSubmissionMode,
  type ProblemContentV1,
  type ProblemRuntimeConfig,
  projectProblemContent,
  type SubmissionMode,
} from "../../catalog/index.ts";
import type { ContestProblemResponse, ContestType } from "../types/contests.ts";
import { findContestRow } from "./contest-row.ts";
import { computeContestStatus } from "./contests.ts";
import { resolveDomainContestProblems } from "./domain-problems.ts";

/**
 * 获取竞赛题目列表（按排序值升序），可选附带当前用户的作答状态。
 *
 * @param contestId 竞赛 UUID
 * @param userId 当前用户 ID（可选，用于计算 user_status）
 * @returns 竞赛题目响应列表
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function getContestProblems(
  contestId: string,
  userId?: string,
  organizer = false,
): Promise<ContestProblemResponse[]> {
  const contest = await findContestRow(contestId);
  const db = getDb();
  // 旧默认域路由也走此读取门面，不能用固定版本恢复已撤销的跨域题面。
  // 扩展迁移尚未回填的旧比赛行由后续收缩迁移统一补齐绑定。
  const bindings = await db.select({ problem_id: contestProblems.problem_id })
    .from(contestProblems).where(and(
      eq(contestProblems.contest_id, contestId),
      isNotNull(contestProblems.domain_problem_binding_id),
    ));
  if (bindings.length) {
    await resolveDomainContestProblems(
      db,
      contest.domain_id ?? DEFAULT_DOMAIN_ID,
      bindings.map((row) => row.problem_id),
      contest.type as ContestType,
      false,
    );
  }
  const hideOiResults = !organizer && contest.type === "oi" &&
    computeContestStatus(contest.start_time, contest.end_time) !== "ended";
  const rows = await db.execute(sql`
    WITH contest_sources AS (
      SELECT user_id, problem_id, contest_id, is_contest_accepted, receipt_sequence, created_at FROM submissions
      UNION ALL
      SELECT user_id, paper_id, contest_id, is_contest_accepted, receipt_sequence, created_at FROM objective_submissions
    )
    SELECT
      cp.problem_id,
      cp.sort_order,
      cp.label,
      cp.score,
      cp.pinned_version_id,
      pv.version AS pinned_version_number,
      -- 题面与派生字段一律以**固定版本的版本内容**为准（缺陷 #2）：
      -- 读 problems 投影会得到"最新版"题面，出现"版本号 V1、内容 V2"的不一致
      pv.content AS pinned_content,
      cp.effective_version_mode,
      cp.required_version_id,
      cp.effective_policy_revision,
      p.title,
      p.description,
      p.difficulty,
      p.judge_type,
      p.is_objective,
      p.runtime_config,
      p.submission_mode,
      p.artifact_max_size_mb,
      p.visibility,
      CASE WHEN COALESCE(p.domain_id, ${DEFAULT_DOMAIN_ID}) = COALESCE(c.domain_id, ${DEFAULT_DOMAIN_ID})
        THEN p.number::text ELSE CONCAT(source_domain.slug, ':', p.number::text)
      END AS display_id,
      CASE
        WHEN ${userId ?? null}::text IS NULL THEN 'untouched'
        -- 通过状态读「竞赛口径有效通过」投影（Handbook §3.4）：
        -- 不再 JOIN 待删除的 evaluation_results，且 exact 策略收紧后立即不再算通过
        WHEN EXISTS (
          SELECT 1
          FROM contest_sources s
          WHERE s.contest_id = cp.contest_id
            AND s.problem_id = cp.problem_id
            AND s.user_id = ${userId ?? null}
            AND s.is_contest_accepted = TRUE
            AND ${!hideOiResults}
            AND s.created_at >= c.start_time AND s.created_at <= c.end_time
            AND (c.type NOT IN ('oi', 'ioi', 'ioi_strict') OR NOT EXISTS (
              SELECT 1 FROM contest_sources later
              WHERE later.user_id = s.user_id AND later.problem_id = s.problem_id
                AND later.contest_id = s.contest_id AND later.receipt_sequence > s.receipt_sequence
                AND later.created_at >= c.start_time AND later.created_at <= c.end_time
            ))
        ) THEN 'solved'
        WHEN EXISTS (
          SELECT 1
          FROM contest_sources s
          WHERE s.contest_id = cp.contest_id
            AND s.problem_id = cp.problem_id
            AND s.user_id = ${userId ?? null}
        ) THEN 'attempted'
        ELSE 'untouched'
      END AS user_status
    FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    JOIN problems p ON p.id = cp.problem_id
    LEFT JOIN domains source_domain ON source_domain.id = COALESCE(p.domain_id, ${DEFAULT_DOMAIN_ID})
    LEFT JOIN problem_versions pv ON pv.id = cp.pinned_version_id
    WHERE cp.contest_id = ${contestId}
    ORDER BY cp.sort_order ASC, cp.label ASC
  `);

  return unwrapRows<Record<string, unknown>>(rows as never).map(
    toContestProblemResponse,
  );
}

/**
 * 竞赛题目行 → 响应对象。
 *
 * **内容字段必须以竞赛固定版本（`contest_problems.pinned_version_id`）为准**
 * （Handbook §2.6/§4.1，缺陷 #2）：
 *
 * - 修复前 `title`/`description`/`judge_type`/`submission_mode`/支持语言/评测后端
 *   均取 `problems` 投影（即"最新版"口径）。竞赛固定 V1、题库已发布 V2 时，
 *   竞赛页展示 V2 题面却按 V1 判卷；
 * - 派生字段（`supported_languages`、`judge_backend`）同样由该版本内容计算，
 *   避免"版本号说 V1、语言/后端却是 V2"；
 * - 难度、可见性、所有权、`display_id` 属于题目**管理信息**，沿用题目身份值。
 *
 * 非编辑者视角（`projectProblemContent(content, false)`）：不下发
 * `runtime_config` / `llm_config`，与竞赛题目响应既有形态一致（竞赛响应本就不含
 * 评测配置）。固定版本内容缺失（数据损坏）时退回题目投影，保证列表不 500。
 */
function toContestProblemResponse(
  row: Record<string, unknown>,
): ContestProblemResponse {
  const versionFields = row.pinned_content === null ||
      row.pinned_content === undefined
    ? null
    : projectProblemContent(row.pinned_content as ProblemContentV1, false);

  // 无版本内容时的兜底口径：题目投影（仅数据损坏时走到）
  const fallbackJudgeType = row.judge_type === "oi" ? "oi" : "dual";
  const fallbackConfig = row.runtime_config as ProblemRuntimeConfig | null;

  const judgeType: "dual" | "oi" = versionFields?.["judge_type"] === "oi" ||
      versionFields?.["judge_type"] === "dual"
    ? versionFields["judge_type"]
    : fallbackJudgeType;
  const isObjective = typeof versionFields?.["is_objective"] === "boolean"
    ? versionFields["is_objective"]
    : row.is_objective === true;
  const judgeBackend = versionFields !== null &&
      "judge_backend" in versionFields
    ? versionFields["judge_backend"] as ContestProblemResponse["judge_backend"]
    : getJudgeBackend(fallbackJudgeType, fallbackConfig, isObjective);
  const supportedLanguages = versionFields !== null &&
      Array.isArray(versionFields["supported_languages"])
    ? versionFields["supported_languages"] as string[]
    : getSubmissionLanguages(fallbackJudgeType, fallbackConfig);
  const submissionMode =
    isValidSubmissionMode(versionFields?.["submission_mode"] as string)
      ? versionFields!["submission_mode"] as SubmissionMode
      : row.submission_mode as ContestProblemResponse["submission_mode"];
  // 注意区分"版本内容显式声明 null"与"版本内容缺失"：前者表示该版本无产物上限，
  // 不能回退到题目投影里的其他版本取值
  const artifactMaxSizeMb = versionFields !== null &&
      "artifact_max_size_mb" in versionFields
    ? versionFields["artifact_max_size_mb"] as number | null
    : row.artifact_max_size_mb === null ||
        row.artifact_max_size_mb === undefined
    ? null
    : Number(row.artifact_max_size_mb);

  return {
    problem_id: row.problem_id as string,
    sort_order: Number(row.sort_order),
    label: row.label as string,
    score: Number(row.score),
    title: typeof versionFields?.["title"] === "string"
      ? versionFields["title"]
      : row.title as string,
    description: typeof versionFields?.["description"] === "string"
      ? versionFields["description"]
      : row.description as string,
    // 难度 / 可见性 / display_id 属于题目管理信息，沿用题目身份值
    difficulty: row.difficulty as string,
    judge_type: judgeType,
    is_objective: isObjective,
    judge_backend: judgeBackend,
    // 竞赛固定作答版本：客户端提交时原样回传（不一致 → 409，绝不自动换版）
    version_id: (row.pinned_version_id as string | null) ?? null,
    version: row.pinned_version_number == null
      ? null
      : Number(row.pinned_version_number),
    // 竞赛 × 题目 有效版本策略与乐观锁版本（管理端切换策略/升级固定版本用）
    effective_version_policy: row.effective_version_mode === "exact"
      ? {
        mode: "exact" as const,
        version_id: (row.required_version_id as string | null) ?? null,
      }
      : { mode: "any" as const },
    effective_version_policy_revision: Number(
      row.effective_policy_revision ?? 0,
    ),
    supported_languages: supportedLanguages,
    display_id: row.display_id as string,
    submission_mode: submissionMode,
    artifact_max_size_mb: artifactMaxSizeMb,
    visibility: row.visibility as ContestProblemResponse["visibility"],
    user_status: row.user_status as ContestProblemResponse["user_status"],
  };
}
