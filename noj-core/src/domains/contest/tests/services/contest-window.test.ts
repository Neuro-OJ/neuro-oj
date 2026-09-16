/**
 * C1 回归测试：赛期门控对「合法但非规范形态」的 ISO 8601 时间必须仍然生效。
 *
 * ## 背景（2026-09-14 评审 C1）
 *
 * `contests.start_time` / `end_time` 是文本列。原实现用
 * `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` 生成同形状
 * 字符串做**字典序**比较，并在注释中断言"与 `new Date().toISOString()` 同格式，
 * 故字典序等价于时间先后"。该前提没有任何机制保证：
 *
 * ```text
 * start = 2026-09-14T10:19:18.087+08:00   end = 2026-09-14T11:20:18.087+08:00
 * nowZ  = 2026-09-14T02:36:16.970Z
 * 字典序谓词 running = false   ← 错（'+' 0x2B < 'Z' 0x5A，end_time > nowZ 恒假）
 * 按时刻比较 running = true    ← 对
 * ```
 *
 * 后果：列表 / 类型计数 / 收藏 / 动态流 / 搜索 / 发布门槛**全部放行**，
 * 赛期题解与通过率抑制同时静默失效。
 *
 * ## 这些测试为什么必须存在
 *
 * 既有全部夹具都用 `new Date().toISOString()` 生成时间，即**只产生规范形态**——
 * 而缺陷只在非规范形态下显现。没有本文件，这类错误假设可以永远绿着。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contestProblems, contests } from "../../../../shared/db/schema.ts";
import {
  filterProblemsInRunningContest,
  isProblemInRunningContest,
  normalizeContestTime,
  runningContestExistsForProblem,
} from "../../index.ts";
import { sql } from "drizzle-orm";
import {
  endedContestTimes,
  nonCanonicalOffsetTimes,
  pendingContestTimes,
  runningContestTimes,
  seedRunningContest,
} from "../../../../shared/testing/contest-fixtures.ts";

const problemId = "contest-window-problem";
const otherProblemId = "contest-window-other";

/** 每个用例前清空竞赛相关表，避免夹具互相污染。 */
async function reset(): Promise<void> {
  await resetDbForTest();
  await getDb().delete(contestProblems);
  await getDb().delete(contests);
}

/**
 * 在"存量脏数据"前提下运行一段逻辑。
 *
 * 迁移 0083 用 `NOT VALID` 添加形态约束：**存量**非规范行会被保留（这正是
 * NOT VALID 的语义），但**新写入**一律受约束。故要构造"库里已存在非规范时间"
 * 这一真实场景，必须临时移除约束以模拟迁移前的库状态——直接插入已被约束拒绝。
 *
 * 测试运行在 preload 的事务中，`ALTER TABLE` 会随事务回滚复原，无需手动恢复。
 */
async function withLegacyDirtyRowsAllowed<T>(fn: () => Promise<T>): Promise<T> {
  await getDb().execute(
    sql`ALTER TABLE contests DROP CONSTRAINT IF EXISTS contests_time_format_check`,
  );
  return await fn();
}

Deno.test({
  name: "contest-window: 规范形态下进行中竞赛被识别",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    await seedRunningContest({ problemIds: [problemId] });
    assertEquals(await isProblemInRunningContest(problemId), true);
    assertEquals(await isProblemInRunningContest(otherProblemId), false);
  },
});

Deno.test({
  name: "contest-window(C1): 带 +08:00 偏移且秒级精度的进行中竞赛仍被识别",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    const times = nonCanonicalOffsetTimes();
    // 前提断言：夹具确实产出了"非规范但合法"的形态，否则本测试是空的
    assertEquals(times.start_time.includes("+08:00"), true);
    assertEquals(times.start_time.includes("."), false);
    assertEquals(Number.isNaN(Date.parse(times.start_time)), false);

    await withLegacyDirtyRowsAllowed(async () => {
      await seedRunningContest({ problemIds: [problemId], times });

      // 修复前：字典序比较返回 false（fail-open）→ 门控失效
      assertEquals(await isProblemInRunningContest(problemId), true);
      const set = await filterProblemsInRunningContest([problemId]);
      assertEquals(set.has(problemId), true);
    });
  },
});

Deno.test({
  name: "contest-window(C1): SQL 谓词对非规范形态同样生效（与 TS 路径一致）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    await withLegacyDirtyRowsAllowed(async () => {
      await seedRunningContest({
        problemIds: [problemId],
        times: nonCanonicalOffsetTimes(),
      });
      // 直接求值共享谓词（必须带 from：drizzle 无 from 的 select 不会执行），
      // 确认 SQL 侧（而非仅 TS 层）已按时刻比较
      const rows = await getDb().select({
        running: sql<boolean>`${
          runningContestExistsForProblem(contestProblems.problem_id)
        }`,
      }).from(contestProblems);
      assertEquals(rows[0]?.running, true);
    });
  },
});

Deno.test({
  name: "contest-window(C1): 负偏移（-05:00）与非整点偏移同样被正确处理",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    // -05:00：'-'（0x2D）同样低于 'Z'，是同一类错误的另一个实例
    await withLegacyDirtyRowsAllowed(async () => {
      await seedRunningContest({
        problemIds: [problemId],
        times: nonCanonicalOffsetTimes(-300),
      });
      assertEquals(await isProblemInRunningContest(problemId), true);
    });
    await reset();
    // +05:30（半小时偏移）：验证不是"整点偏移特例"
    await withLegacyDirtyRowsAllowed(async () => {
      await seedRunningContest({
        problemIds: [problemId],
        times: nonCanonicalOffsetTimes(330),
      });
      assertEquals(await isProblemInRunningContest(problemId), true);
    });
  },
});

Deno.test({
  name: "contest-window: pending 与 ended 竞赛不触发门控（含非规范形态）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    await seedRunningContest({
      problemIds: [problemId],
      times: pendingContestTimes(),
    });
    assertEquals(await isProblemInRunningContest(problemId), false);
    await reset();
    await seedRunningContest({
      problemIds: [problemId],
      times: endedContestTimes(),
    });
    assertEquals(await isProblemInRunningContest(problemId), false);
  },
});

Deno.test({
  name: "contest-window: 空列表返回空集合，不产生空 IN 查询",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    await seedRunningContest({ problemIds: [problemId] });
    assertEquals((await filterProblemsInRunningContest([])).size, 0);
  },
});

Deno.test({
  name: "contest-window: 多竞赛重叠时并集判定（一个结束一个进行中）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    await seedRunningContest({
      problemIds: [problemId],
      times: endedContestTimes(),
    });
    await seedRunningContest({
      problemIds: [problemId, otherProblemId],
      times: runningContestTimes(),
    });
    const set = await filterProblemsInRunningContest([
      problemId,
      otherProblemId,
    ]);
    assertEquals(set.has(problemId), true);
    assertEquals(set.has(otherProblemId), true);
  },
});

Deno.test({
  name: "contest-window: 形态非法的时间按 fail-closed（判为进行中，隐藏内容）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    // 注意：必须让谓词作用在**真实列**上。PostgreSQL 会在计划期对**常量**做
    // 常量折叠，把 `'not-a-date'::timestamptz` 直接求值并报错——那样测的就不是
    // CASE 的求值顺序，而是解析器的行为。生产路径永远是比较列值，故用列测试。
    //
    // 这里用"空格分隔"的形态：它能通过表的 `end_time > start_time` CHECK
    // （字典序恰好成立），却过不了规范形态正则——正是"合法入库但形态不规范"的
    // 真实残留场景。
    const id = await withLegacyDirtyRowsAllowed(async () =>
      await seedRunningContest({
        problemIds: [problemId],
        times: {
          start_time: "2026-09-14 10:00:00",
          end_time: "2099-09-15 11:00:00",
        },
      })
    );
    assertEquals(typeof id, "string");
    // 无法通过形态守卫 → 按进行中处理（隐藏内容，而非泄露内容）
    assertEquals(await isProblemInRunningContest(problemId), true);

    // 对照：同一场竞赛改成**规范形态**且确已结束 → 正常放行（守卫不影响正确判定）。
    // 必须同时改 start_time：只改 end_time 会留下非规范的 start_time，
    // 守卫依旧 fail-closed（这正是"形态不得不规范"的表现，非缺陷）。
    await getDb().update(contests)
      .set({
        start_time: new Date(Date.now() - 7_200_000).toISOString(),
        end_time: new Date(Date.now() - 1_000).toISOString(),
      })
      .where(eq(contests.id, id));
    assertEquals(await isProblemInRunningContest(problemId), false);
  },
});

Deno.test({
  name: "contest-window: normalizeContestTime 收敛各种合法形态到同一时刻",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const base = Date.parse("2026-09-14T02:19:18.087Z");
    const canonical = new Date(base).toISOString();
    // 同一时刻的不同合法写法必须归一到完全相同的字符串
    assertEquals(
      normalizeContestTime("2026-09-14T10:19:18.087+08:00"),
      canonical,
    );
    assertEquals(normalizeContestTime("2026-09-14T02:19:18.087Z"), canonical);
    assertEquals(
      normalizeContestTime("2026-09-13T21:19:18.087-05:00"),
      canonical,
    );
    // 秒级精度补零到毫秒
    assertEquals(
      normalizeContestTime("2026-09-14T02:19:18Z"),
      "2026-09-14T02:19:18.000Z",
    );
  },
});

Deno.test({
  name: "contest-window: 写侧规范化后库中时间不残留偏移形态",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    const times = nonCanonicalOffsetTimes();
    // 夹具直接写库（模拟存量脏数据）；确认它确实是脏的
    const id = await withLegacyDirtyRowsAllowed(async () =>
      await seedRunningContest({ problemIds: [problemId], times })
    );
    const before = await getDb().select({ start: contests.start_time })
      .from(contests).where(eq(contests.id, id));
    assertEquals(before[0]?.start.includes("+08:00"), true);

    // 经 normalizeContestTime 处理后不再含偏移（写侧修复的形状保证）
    const normalized = normalizeContestTime(before[0]!.start);
    assertEquals(normalized.endsWith("Z"), true);
    assertEquals(normalized.includes("+"), false);
    // 谓词仍对该题目成立（写侧规范化后读侧结论不变）
    const reparsed = await getDb().select({
      running: sql<
        boolean
      >`${runningContestExistsForProblem(contestProblems.problem_id)}`,
    }).from(contestProblems);
    assertEquals(reparsed[0]?.running, true);
  },
});

/**
 * 第三道防线（迁移 0083 / schema-ddl）的回归测试。
 *
 * 前两道（写侧规范化、读侧按时刻比较）都在应用层。若有人绕过服务层直接写库
 * （管理脚本、人工修数据、未来新增的写入路径），DB 形态约束是最后的兜底。
 */
Deno.test({
  name: "contest-window: DB 形态约束拒绝非规范时间的新写入（第三道防线）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    const now = new Date().toISOString();
    const dirty = nonCanonicalOffsetTimes();
    // 迁移 0083 的 NOT VALID 约束对**新写入**生效：非规范形态必须被拒绝
    let rejected = false;
    try {
      await getDb().insert(contests).values({
        id: crypto.randomUUID(),
        title: "非规范时间写入",
        description: "",
        start_time: dirty.start_time,
        end_time: dirty.end_time,
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_by: "0",
        created_at: now,
        updated_at: now,
      });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
    // 注意：约束违例会**中止当前事务**（PostgreSQL 语义），故本用例不再继续写库；
    // 规范形态可正常写入由上方「规范形态下进行中竞赛被识别」覆盖。
  },
});

Deno.test({
  name: "contest-window: freeze_start_time 非规范形态同样被约束拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await reset();
    const now = new Date().toISOString();
    const times = runningContestTimes();
    let rejected = false;
    try {
      await getDb().insert(contests).values({
        id: crypto.randomUUID(),
        title: "非规范封榜时间",
        description: "",
        start_time: times.start_time,
        end_time: times.end_time,
        freeze_start_time: "2026-09-14 10:00:00",
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_by: "0",
        created_at: now,
        updated_at: now,
      });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  },
});
