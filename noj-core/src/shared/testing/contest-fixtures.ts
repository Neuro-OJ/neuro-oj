/**
 * 赛期门控共享测试夹具。
 *
 * ## 为什么必须共享（2026-09-14 评审 C1 的根因）
 *
 * C1（按文本字典序比较竞赛时间 → `+08:00` 形态 fail-open）之所以能存活，
 * **根因是测试覆盖**：W2/W3 两个工作流的全部测试中，`contest` 一词在 catalog
 * 的统计测试里出现 **0 次**，`running_contest` 这一生产字符串在任何测试中也是
 * **0 次**——抑制分支从未被执行过。
 *
 * 更隐蔽的一点：既有夹具**全部**用 `new Date(...).toISOString()` 生成时间，
 * 即永远只产生"规范形态"。而缺陷恰恰只在**非规范但合法**的 ISO 8601 形态下
 * 显现。用规范形态做夹具，会让类级错误假设永远测不出来。
 *
 * 故本夹具提供 {@link nonCanonicalOffsetTimes}：产出**同一时刻**的
 * `+08:00` 偏移写法，专用于把 C1 钉死在回归测试里。
 *
 * 用法：
 * ```ts
 * const contest = await seedRunningContest({ problemIds: [problemId] });
 * // 或验证形态无关性
 * const times = nonCanonicalOffsetTimes();
 * await seedRunningContest({ problemIds: [problemId], times });
 * ```
 */
import { getDb } from "../db/connection.ts";
import { contestProblems, contests, problems } from "../db/schema.ts";

/** 竞赛时间对（开始/结束）。 */
export interface ContestTimes {
  start_time: string;
  end_time: string;
}

/**
 * 由题目 id 稳定派生一个题号。
 *
 * 用于自动补建夹具题目时满足 `(type, number)` 唯一约束：同一 id 每次得到同一
 * 编号（故可 `onConflictDoNothing` 重复调用），不同 id 冲突概率可忽略。
 */
function stableProblemNumber(problemId: string): number {
  let hash = 0;
  for (let i = 0; i < problemId.length; i++) {
    hash = (hash * 31 + problemId.charCodeAt(i)) % 100_000;
  }
  // 落在 9xxxx 段，远离种子题（1001-1003）与常见测试编号
  return 900_000 + hash;
}

/** 默认夹具时间：已开始 1 分钟、1 小时后结束。 */
export function runningContestTimes(): ContestTimes {
  return {
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** 已结束的竞赛时间（用于验证"赛后自动放行"）。 */
export function endedContestTimes(): ContestTimes {
  return {
    start_time: new Date(Date.now() - 7_200_000).toISOString(),
    end_time: new Date(Date.now() - 1_000).toISOString(),
  };
}

/** 未开始的竞赛时间（用于验证"pending 不门控"）。 */
export function pendingContestTimes(): ContestTimes {
  return {
    start_time: new Date(Date.now() + 3_600_000).toISOString(),
    end_time: new Date(Date.now() + 7_200_000).toISOString(),
  };
}

/**
 * 与 {@link runningContestTimes} **同一时刻**，但写成带 `+08:00` 偏移的合法
 * ISO 8601，且**不带毫秒**（秒级精度）。
 *
 * 这两个特征各自都足以击穿"字典序等价于时间先后"的错误假设：
 * - `+08:00` 的 `+`（0x2B）低于 `Z`（0x5A）→ `end_time > nowZ` 恒假（fail-open）；
 * - 秒级精度时 `'Z' > '.'` → 起始那一秒的谓词为 false（约 1 秒窗口）。
 *
 * 写侧现已规范化为 `toISOString()`，故这类值只可能来自存量数据；本夹具直接
 * 写入库中正是为了模拟存量非规范行，验证读侧已按**时刻**而非文本比较。
 *
 * 注意：`toISOString` 的 `+08:00` 换算需要手动构造——`Date` 的 `toISOString`
 * 永远输出 `Z`，故此处显式偏移后裁剪毫秒。
 */
export function nonCanonicalOffsetTimes(offsetMinutes = 480): ContestTimes {
  const shift = (ms: number): string => {
    // 把 UTC 毫秒加上偏移后按 UTC 字段格式化，即得到该偏移下的本地时间写法
    const shifted = new Date(ms + offsetMinutes * 60_000);
    const iso = shifted.toISOString();
    // 裁剪毫秒（秒级精度）并附上偏移量，形如 2026-09-14T10:19:18+08:00
    return `${iso.slice(0, 19)}+${
      String(Math.floor(offsetMinutes / 60)).padStart(2, "0")
    }:00`;
  };
  return {
    start_time: shift(Date.now() - 60_000),
    end_time: shift(Date.now() + 3_600_000),
  };
}

/**
 * 插入一场竞赛（含题目关联），返回竞赛 id。
 *
 * 直接写库而非走 `createContest`：夹具需要能写入**任意形态**的时间字符串
 * （含非规范形态），而 `createContest` 会规范化——那正是 C1 修复的一部分，
 * 用它就无法构造"存量脏数据"场景。
 *
 * 关联题目若不存在会自动补建最小行（`contest_problems.problem_id` 有外键约束），
 * 让调用方无需为"只想测门控"而重复搭建题目夹具。
 *
 * @param options.problemIds 关联题目 id 列表。
 * @param options.times 竞赛时间；缺省为进行中。
 * @param options.title 标题；缺省自动生成唯一值。
 * @param options.createdBy 创建者 id；缺省 `"0"`（root）。
 * @returns 竞赛 id。
 */
export async function seedRunningContest(options: {
  problemIds: string[];
  times?: ContestTimes;
  title?: string;
  createdBy?: string;
}): Promise<string> {
  const times = options.times ?? runningContestTimes();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  await db.insert(contests).values({
    id,
    title: options.title ?? `夹具竞赛 ${Date.now()}-${id.slice(0, 8)}`,
    description: "",
    start_time: times.start_time,
    end_time: times.end_time,
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_by: options.createdBy ?? "0",
    created_at: now,
    updated_at: now,
  });
  if (options.problemIds.length > 0) {
    // 补建缺失题目。编号由题目 id 的字符哈希派生：同一 id 稳定得到同一编号
    // （重复调用 onConflictDoNothing 安全），不同 id 几乎不可能撞上
    // (type, number) 唯一约束——用递增基数会在并发/多次调用下冲突。
    await db.insert(problems).values(
      options.problemIds.map((problemId) => ({
        id: problemId,
        title: `夹具题目 ${problemId}`,
        description: "",
        difficulty: "easy",
        runtime_config: {},
        number: stableProblemNumber(problemId),
        type: "U",
        visibility: "public",
        owner_id: options.createdBy ?? "0",
        created_at: now,
        updated_at: now,
      })),
    ).onConflictDoNothing();
    await db.insert(contestProblems).values(
      options.problemIds.map((problemId, index) => ({
        contest_id: id,
        problem_id: problemId,
        sort_order: index,
        label: String.fromCharCode(65 + index),
        score: 10000,
      })),
    );
  }
  return id;
}

/**
 * 插入一场**只有合法但非规范形态**时间的进行中竞赛。
 *
 * 语义化包装，让 C1 回归测试的意图在调用点自明：这不是"随便一场竞赛"，
 * 而是"形态攻击"夹具。
 */
export function seedNonCanonicalTimeRunningContest(
  problemIds: string[],
  createdBy?: string,
): Promise<string> {
  return seedRunningContest({
    problemIds,
    times: nonCanonicalOffsetTimes(),
    createdBy,
  });
}
