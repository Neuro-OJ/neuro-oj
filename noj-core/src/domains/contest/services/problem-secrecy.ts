/**
 * 公开赛题目保密事实：题目当前是否被**尚未结束的公开赛**（`contests.kind = 'public'`）
 * 收编，以及是哪些竞赛。
 *
 * 供题目读/写路径门控复用（见 catalog 域 `problem-access.ts` 的 `secrecy` 输入）：
 * 赛前与赛中的公开赛题目对非 owner/管理员一律按"不存在"处理（404），
 * 竞赛 `end_time` 一过自动恢复常规可见性（赛后复盘、补题、题解均可访问）。
 *
 * **设计取舍（与 `problem-exposure.ts` 一致，有意为之）**：
 * - **不使用缓存、不引入调度任务**：时间窗口实时比较，竞赛开始/结束无需任何状态
 *   翻转动作，因此不新增进程内可变状态（多副本约束见
 *   `dev-docs/engineering/domain-boundaries.md`）。
 * - **不按竞赛 `is_public` 分档**：链式/隐链公开赛（`is_public = false`）同样保密，
 *   保密只取决于 `kind`——隐链竞赛恰恰更需要保密。
 * - **邀请赛（`kind = 'invite'`）不参与**：邀请赛本身的题目访问已由参赛者身份与
 *   邀请码门控，本规则按需求只覆盖公开赛。
 *
 * 时间比较按「时刻」而非「文本」，复用 `unendedWindowCondition`
 * （`::timestamptz` + 形态守卫），杜绝字典序比较对 `+08:00` 形态静默 fail-open。
 */
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contestProblems, contests } from "./../../../shared/db/schema.ts";
import { unendedWindowCondition } from "./contest-window.ts";

/** 触发保密的一场比赛（足够渲染"已被关联到竞赛 …"提示）。 */
export type PublicContestSecrecyRef = {
  /** 竞赛 UUID */
  contestId: string;
  /** 竞赛公开 ID（`ct-…`），用于构造竞赛首页链接 */
  publicId: string;
  /** 竞赛标题 */
  title: string;
};

/**
 * 取该题目关联的、尚未结束的公开赛列表。
 *
 * @param problemId 题目 UUID。
 * @returns 触发保密的竞赛列表（按结束时间升序，最近结束的在前）；空数组表示
 *          该题目当前不受公开赛保密约束。
 */
export async function loadPublicContestSecrecy(
  problemId: string,
): Promise<PublicContestSecrecyRef[]> {
  const rows = await getDb()
    .select({
      contestId: contests.id,
      publicId: contests.public_id,
      title: contests.title,
    })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      eq(contestProblems.problem_id, problemId),
      eq(contests.kind, "public"),
      unendedWindowCondition(contests.end_time),
    ))
    .orderBy(asc(contests.end_time), asc(contests.id));
  return rows;
}

/**
 * 「该题目被尚未结束的公开赛收编」的共享 SQL 谓词：返回 `EXISTS (...)` 片段。
 *
 * 这是**公开赛-题目保密事实的单一真相源在 SQL 层的出口**（审计 §4.1）。所有需要在
 * 数据库层排除/标注这类题目的位置（题库列表、题单、个人主页、全局搜索、社区帖子
 * 列表）都必须复用它，禁止各自手写时间窗口比较——此前四处副本的口径漂移正是
 * VULN-02 / VULN-07 的根因：
 * - 有的只查 `running`（`start <= now < end`），于是**赛前筹备期（pending）完全放行**；
 * - 有的漏掉 `discussion` 类型，只门控 `solution`。
 *
 * 判定口径为 `contests.kind = 'public' AND now < end_time`（含 pending 与 running），
 * 即「从公开赛收编该题起，直到比赛结束」全程保密；`end_time` 一过自动放行
 * （赛后复盘、补题、题解均恢复正常）。
 *
 * 形态守卫与 fail-closed 取向由 {@link unendedWindowCondition} 提供（结束时间无法
 * 解析时按"未结束"处理，继续保密）。
 *
 * @param problemIdExpr 题目 id 的列引用或 SQL 表达式（如 `problems.id`、
 *                      `community_posts.problem_id`）。
 * @returns 该题目受未结束公开赛保密时为真的 `EXISTS` 子查询。
 */
export function unendedPublicContestForProblem(
  problemIdExpr: AnyColumn | SQL,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    WHERE cp.problem_id = ${problemIdExpr}
      AND c.kind = 'public'
      AND ${unendedWindowCondition(sql`c.end_time`)}
  )`;
}

/**
 * 单条内存判定：该题目当前是否被**尚未结束的公开赛**收编。
 *
 * 供写入路径（发帖/发题解前的 Write Guard）与需要逐条判定的读路径使用；
 * SQL 列表场景请用 {@link unendedPublicContestForProblem}（相关子查询，不受题量
 * 规模影响，也不会因 IN 列表上限静默漏判）。
 *
 * @param problemId 题目 UUID。
 * @returns 受未结束公开赛保密时为 true。
 */
export async function isProblemInUnendedPublicContest(
  problemId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ contestId: contests.id })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      eq(contestProblems.problem_id, problemId),
      eq(contests.kind, "public"),
      unendedWindowCondition(contests.end_time),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * 判定全站当前是否存在任何尚未结束的公开赛（含 pending 筹备期与 running 进行期）。
 *
 * 供赛时社区全局静默（决策 1）复用：普通用户在有未结束公开赛时禁止发讨论帖和动态。
 *
 * @returns 存在未结束公开赛时为 true。
 */
export async function hasUnendedPublicContest(): Promise<boolean> {
  const rows = await getDb()
    .select({ contestId: contests.id })
    .from(contests)
    .where(and(
      eq(contests.kind, "public"),
      unendedWindowCondition(contests.end_time),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * 按竞赛 id 批量判定「尚未结束」（`now < end_time`，含 pending 与 running）。
 *
 * 供**竞赛维度的读路径门控**复用（客观题赛期屏蔽对错与分数：需要按提交所属竞赛
 * 判断是否已结束）。语义与 {@link unendedWindowCondition} 完全一致，包括
 * **fail-closed**：`end_time` 无法解析时按「未结束」处理（继续隐藏），而不是泄露。
 *
 * @param contestIds 竞赛 UUID 列表；空列表直接返回空集合（避免空 IN 查询）。
 * @returns 尚未结束的竞赛 id 集合。
 */
export async function filterUnendedContestIds(
  contestIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(contestIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({
      id: contests.id,
      // 用同一 SQL 条件**作为投影列**而不是 WHERE 过滤：这样既能知道"哪些未结束"，
      // 又能区分"哪些竞赛压根不存在"（后者必须 fail-closed 视为未结束）。
      // 放进 WHERE 会让"已结束"与"不存在"在结果里都消失，无法区分。
      unended: sql<boolean>`${unendedWindowCondition(contests.end_time)}`
        .as("unended"),
    })
    .from(contests)
    .where(inArray(contests.id, ids));
  const unended = new Set<string>();
  const found = new Set<string>();
  for (const row of rows) {
    found.add(row.id);
    if (row.unended) unended.add(row.id);
  }
  // 查不到的竞赛 id：无法证明已结束 → fail-closed 视为未结束（继续隐藏）
  for (const id of ids) {
    if (!found.has(id)) unended.add(id);
  }
  return unended;
}
