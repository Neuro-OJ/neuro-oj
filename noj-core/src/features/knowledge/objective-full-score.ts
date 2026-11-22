/**
 * 客观题套卷满分（知识图谱「达标」判定用）。
 *
 * `evaluation_attempts.score` 是 ×100 记分（0–10000），满分口径 = 小题数 × 100。
 * 取作答版本的稳定点：题库默认作答版本（`exact` → 要求版本、`any` → 最新版），
 * 与提交路径 `resolveSubmissionVersion` 一致；未发布版本返回 null。
 */
import { and, eq } from "drizzle-orm";
import {
  getPaperOrThrow,
  listVersionQuestions,
} from "../../modules/problems/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import { problemVersions } from "../../shared/db/schema.ts";

/** 单题记分单位（与 `FULL_SCORE = 10000` / 100 小题口径一致）。 */
export const OBJECTIVE_SCORE_UNIT = 100;

/** 读取套卷作答版本的满分；无发布版本返回 null。 */
export async function objectiveFullScore(
  paperId: string,
): Promise<number | null> {
  let paper;
  try {
    paper = await getPaperOrThrow(paperId);
  } catch {
    return null;
  }
  if (!paper.is_objective) return null;
  const versionId = paper.effective_version_mode === "exact"
    ? paper.required_version_id
    : paper.latest_version_id;
  if (!versionId) return null;
  const [version] = await getDb().select({ id: problemVersions.id }).from(
    problemVersions,
  ).where(and(
    eq(problemVersions.id, versionId),
    eq(problemVersions.problem_id, paper.id),
  )).limit(1);
  if (!version) return null;
  const questions = await listVersionQuestions(version.id);
  if (questions.length === 0) return null;
  return questions.length * OBJECTIVE_SCORE_UNIT;
}
