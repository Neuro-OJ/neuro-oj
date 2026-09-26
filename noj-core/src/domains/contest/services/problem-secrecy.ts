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
import { and, asc, eq } from "drizzle-orm";
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
