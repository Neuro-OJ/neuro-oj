/**
 * 竞赛时间窗口：**唯一**的"进行中"判定来源。
 *
 * ## 为什么需要这个模块
 *
 * `contests.start_time` / `end_time` 是 ISO 8601 **文本**列。该判定此前在四处各自
 * 手写，用 `to_char(now() ...)` 生成同形状字符串做**字典序比较**，并在注释中断言
 * "与 `new Date().toISOString()` 同格式，故字典序等价于时间先后"。该前提**没有任何
 * 机制保证**，实测为 fail-open：
 *
 * ```text
 * start = 2026-09-14T10:19:18.087+08:00   end = 2026-09-14T11:20:18.087+08:00
 * nowZ  = 2026-09-14T02:36:16.970Z
 * 字典序谓词 running = false   ← 错（'+' 是 0x2B，低于 'Z' 的 0x5A，故 end_time > nowZ 恒假）
 * 按时刻比较 running = true    ← 对
 * ```
 *
 * 后果不是显示错误：`computeContestStatus`（走 `Date.parse`）说"进行中"，而 SQL
 * 谓词说"未进行"，于是**列表 / 类型计数 / 收藏 / 动态流 / 搜索 / 发布门槛全部放行**，
 * 赛期题解门控与通过率抑制同时静默失效（2026-09-14 评审 C1）。
 *
 * ## 三道防线
 *
 * 1. **写侧规范化**（{@link normalizeContestTime}）：入库时间统一为
 *    `new Date(...).toISOString()` 的规范形态，从源头消除多形态数据。
 * 2. **读侧按时刻比较**（{@link runningWindowCondition} 等）：不再比较文本，改为
 *    比较 `::timestamptz`。全部调用点复用本模块，杜绝再次漂移。
 * 3. **DB 形态约束**：迁移 `0083` 规范化存量行并加 `NOT VALID` 形态 CHECK。
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * 规范竞赛时间形态的正则（与 `Date.prototype.toISOString()` 输出一致）。
 *
 * 供读侧形态守卫与迁移的 CHECK 约束共用，避免两处漂移；刻意写成 PostgreSQL
 * POSIX 正则（`~` 运算符），非 JS 正则。
 */
export const CONTEST_TIME_ISO_REGEX_SQL =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

/**
 * 规范化竞赛时间为规范 ISO 8601（UTC，毫秒精度）。
 *
 * 写侧统一调用（`contests.ts` 的创建/更新路径）。
 *
 * @param value 任意可被 `Date.parse` 接受的 ISO 8601 时间串（允许带时区偏移）。
 * @returns 规范形态 `YYYY-MM-DDTHH:mm:ss.sssZ`。
 * @throws {RangeError} 值不可解析时抛错（调用方应先经 `validateTimes` 校验）。
 */
export function normalizeContestTime(value: string): string {
  return new Date(value).toISOString();
}

/** 规范化可空竞赛时间；`null` / `undefined` 原样透传。 */
export function normalizeOptionalContestTime(
  value: string | null | undefined,
): string | null {
  return value === null || value === undefined
    ? null
    : normalizeContestTime(value);
}

/**
 * "竞赛窗口包含当前时刻"的判定条件（`start <= now < end`），按**时刻**比较。
 *
 * ### 为什么用 CASE 而不是 `AND`
 *
 * `start_time::timestamptz` 对**形态非法**的文本会**抛错**。若直接写进 `WHERE`，
 * 一条脏数据就能让社区列表 / 搜索 / 题目详情全部 500（可用性事故）。SQL 的
 * `AND`/`OR` **不保证**短路求值，所以"先用正则守卫、再转换"写在 `AND` 里并不安全。
 * `CASE` 的求值顺序**有保证**：只有 `WHEN` 为真时才求值 `THEN`。
 *
 * ### 为什么形态正则是必要的、但**不充分**的
 *
 * 正则只能证明"形状"合法，证明不了"语义"合法：`2026-13-01T00:00:00.000Z` 完全
 * 匹配正则（四位年、两位月…），但 `::timestamptz` 会抛 `date/time field value out
 * of range`——CASE 也可能先求值 `THEN`，一条这样的脏行即可让门控查询 500。
 * 因此 `WHEN` 里追加 `pg_input_is_valid(col, 'timestamptz')`（PG 16+）：它按
 * **同一条解析路径**判断值能否转成 timestamptz，不抛错、只返回布尔。两道守卫
 * 都通过后 `THEN` 里的 cast 才可能安全（评审 #3）。
 *
 * ### 形态非法时为何判为"进行中"（fail-closed）
 *
 * 本条件的用途是**安全门控**（赛期隐藏题解与通过率）。窗口无法解析时无法证明竞赛
 * 已结束，故按"进行中"处理——隐藏内容，而不是泄露内容。正常数据不会走到该分支：
 * 写侧已规范化，迁移 0083 另有形态约束兜底。
 *
 * @param startTimeExpr 竞赛开始时间列引用或 SQL 表达式。
 * @param endTimeExpr 竞赛结束时间列引用或 SQL 表达式。
 * @returns 可直接放进 `WHERE` / `AND` 的布尔 SQL 片段。
 */
export function runningWindowCondition(
  startTimeExpr: AnyColumn | SQL,
  endTimeExpr: AnyColumn | SQL,
): SQL {
  return sql`CASE
    WHEN ${startTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND ${endTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${startTimeExpr}, 'timestamptz')
     AND pg_input_is_valid(${endTimeExpr}, 'timestamptz')
    THEN ${startTimeExpr}::timestamptz <= now()
     AND ${endTimeExpr}::timestamptz > now()
    ELSE true
  END`;
}

/**
 * "竞赛窗口尚未结束"的判定条件（`now < end`），按**时刻**比较。
 *
 * 供**公开赛题目保密**门控使用：题目一旦被关联到尚未结束的公开赛，就对非
 * owner/管理员不可见（见 `problem-secrecy.ts` 与 `resolveProblemAccess`）；
 * 竞赛 `end_time` 一过，门控自动失效、题目恢复常规可见性——判定纯派生自时间，
 * 无需任何状态翻转动作或多副本共享状态。
 *
 * 形态守卫、`CASE` 求值顺序与 fail-closed 取向与 {@link runningWindowCondition}
 * 完全一致：结束时间无法解析时**无法证明竞赛已结束**，故按"未结束"处理——
 * 继续保密（隐藏内容），而不是泄露内容。
 *
 * @param endTimeExpr 竞赛结束时间列引用或 SQL 表达式。
 * @returns 可直接放进 `WHERE` / `AND` 的布尔 SQL 片段。
 */
export function unendedWindowCondition(endTimeExpr: AnyColumn | SQL): SQL {
  return sql`CASE
    WHEN ${endTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${endTimeExpr}, 'timestamptz')
    THEN ${endTimeExpr}::timestamptz > now()
    ELSE true
  END`;
}

/**
 * "该题目处于进行中竞赛"的共享 SQL 谓词：返回 `EXISTS (...)` 片段。
 *
 * 供 community 域（题解门控、动态流）复用——此前这些位置各持一份带错误字典序假设的
 * 副本。取值 `unknown` 只可能是题目 id 的列引用或 SQL 表达式。
 *
 * @param problemIdExpr 题目 id 的列引用或 SQL 表达式（如 `community_posts.problem_id`）。
 * @returns 该题目当前处于进行中竞赛时为真的 `EXISTS` 子查询。
 */
export function runningContestExistsForProblem(
  problemIdExpr: AnyColumn | SQL,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    WHERE cp.problem_id = ${problemIdExpr}
      AND ${runningWindowCondition(sql`c.start_time`, sql`c.end_time`)}
  )`;
}

/**
 * "进行中竞赛所包含的题目 id 集合"子查询，用于 `IN (...)` 反连接。
 *
 * 与 {@link runningContestExistsForProblem} 同一判定口径（共用
 * {@link runningWindowCondition}），供 search 域的索引查询复用。
 *
 * @returns 选出进行中竞赛题目 id 的子查询 SQL 片段。
 */
export function runningContestProblemIds(): SQL {
  return sql`(
    SELECT cp.problem_id FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    WHERE ${runningWindowCondition(sql`c.start_time`, sql`c.end_time`)}
  )`;
}
