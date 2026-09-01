import { Hono } from "hono";
import { and, count, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../db/schema.ts";

const stats = new Hono();

/**
 * 公开站点统计端点（只读、无鉴权）。
 *
 * 返回题目数、提交总数、注册用户数、评测通过数，
 * 供「关于」页数据面板展示。统计口径与 rankings / dashboard 服务一致：
 * 通过数 = evaluation_results.status = 'finished' 且 score > 0 的行数。
 *
 * 四个 count() 并发执行；MVP 阶段数据量可接受，后续量大时可加缓存（见 design.md Risks）。
 */
stats.get("/stats", async (c) => {
  const db = getDb();
  const [problemsCount, submissionsCount, usersCount, acceptedCount] =
    await Promise.all([
      db.select({ n: count() }).from(problems),
      db.select({ n: count() }).from(submissions),
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(evaluationResults).where(
        and(
          eq(evaluationResults.status, "finished"),
          sql`${evaluationResults.score} > 0`,
        ),
      ),
    ]);

  return c.json({
    data: {
      problems: Number(problemsCount[0]?.n ?? 0),
      submissions: Number(submissionsCount[0]?.n ?? 0),
      users: Number(usersCount[0]?.n ?? 0),
      accepted: Number(acceptedCount[0]?.n ?? 0),
    },
  });
});

export default stats;
