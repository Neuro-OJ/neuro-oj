/**
 * 公开赛保密事实取数测试（DB）。
 *
 * 判定口径：题目被关联到 `kind = 'public'` 且 `now < end_time` 的竞赛 ⇒ 保密；
 * 赛前（pending）也保密，赛后（ended）自动失效，邀请赛（invite）不参与。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  createContest,
  deleteContest,
  filterUnendedContestIds,
  isProblemInUnendedPublicContest,
  loadPublicContestSecrecy,
  unendedPublicContestForProblem,
} from "../../index.ts";

await resetDbForTest();

async function createUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createProblem(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `保密判定测试题 ${prefix}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number: Math.floor(Math.random() * 1_000_000) + 9_000_000,
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createContestWith(
  prefix: string,
  opts: {
    kind?: "public" | "invite";
    startOffsetMs: number;
    endOffsetMs: number;
    problemIds: string[];
    creatorId: string;
  },
): Promise<string> {
  const contest = await createContest(
    {
      title: `保密判定 ${prefix} ${Date.now()}_${
        Math.random().toString(36).slice(2, 8)
      }`,
      start_time: new Date(Date.now() + opts.startOffsetMs).toISOString(),
      end_time: new Date(Date.now() + opts.endOffsetMs).toISOString(),
      type: "kaggle",
      problems: opts.problemIds.map((problemId, index) => ({
        problem_id: problemId,
        label: String.fromCharCode(65 + index),
        sort_order: index,
        score: 10000,
      })),
    },
    opts.creatorId,
    true,
  );
  if (opts.kind === "invite") {
    // createContest 的 kind 由调用方/DB 默认决定，测试内直接改列以覆盖 invite。
    await getDb()
      .update(contests)
      .set({ kind: "invite" })
      .where(eq(contests.id, contest.id));
  }
  return contest.id;
}

/** 便捷：按 id 集合过滤题目（谓词测试用）。 */
function inArrayIds(ids: string[]) {
  return inArray(problems.id, ids);
}

async function cleanup(
  contestIds: string[],
  problemIds: string[],
  userIds: string[],
): Promise<void> {
  for (const id of contestIds) await deleteContest(id).catch(() => {});
  for (const id of problemIds) {
    await getDb().delete(problems).where(eq(problems.id, id)).catch(() => {});
  }
  for (const id of userIds) {
    await getDb().delete(users).where(eq(users.id, id)).catch(() => {});
  }
}

Deno.test({
  name: "problem-secrecy: 关联进行中公开赛 → 命中保密，返回竞赛引用",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-1");
    const problemId = await createProblem("running");
    const contestId = await createContestWith("running", {
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [problemId],
      creatorId,
    });
    try {
      const refs = await loadPublicContestSecrecy(problemId);
      assertEquals(refs.length, 1);
      assertEquals(refs[0].contestId, contestId);
      assertEquals(refs[0].publicId.length > 0, true);
      assertEquals(refs[0].title.length > 0, true);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-secrecy: 赛前（pending）公开赛同样保密",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-2");
    const problemId = await createProblem("pending");
    const contestId = await createContestWith("pending", {
      startOffsetMs: 60_000,
      endOffsetMs: 120_000,
      problemIds: [problemId],
      creatorId,
    });
    try {
      assertEquals((await loadPublicContestSecrecy(problemId)).length, 1);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-secrecy: 竞赛结束后保密自动失效（赛后复盘可见）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-3");
    const problemId = await createProblem("ended");
    const contestId = await createContestWith("ended", {
      startOffsetMs: -120_000,
      endOffsetMs: -60_000,
      problemIds: [problemId],
      creatorId,
    });
    try {
      assertEquals(await loadPublicContestSecrecy(problemId), []);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-secrecy: 邀请赛（invite）不参与保密",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-4");
    const problemId = await createProblem("invite");
    const contestId = await createContestWith("invite", {
      kind: "invite",
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [problemId],
      creatorId,
    });
    try {
      assertEquals(await loadPublicContestSecrecy(problemId), []);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-secrecy: 未关联任何竞赛 → 空（不影响常规可见性）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-5");
    const problemId = await createProblem("free");
    try {
      assertEquals(await loadPublicContestSecrecy(problemId), []);
    } finally {
      await cleanup([], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-secrecy: 同时关联多场未结束公开赛 → 全部返回（供横幅罗列）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-creator-6");
    const problemId = await createProblem("multi");
    const firstId = await createContestWith("multi-a", {
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [problemId],
      creatorId,
    });
    const secondId = await createContestWith("multi-b", {
      startOffsetMs: -60_000,
      endOffsetMs: 300_000,
      problemIds: [problemId],
      creatorId,
    });
    try {
      const refs = await loadPublicContestSecrecy(problemId);
      assertEquals(
        refs.map((ref) => ref.contestId).sort(),
        [
          firstId,
          secondId,
        ].sort(),
      );
      // 按结束时间升序：最近结束的排在前
      assertEquals(refs[0].contestId, firstId);
    } finally {
      await cleanup([firstId, secondId], [problemId], [creatorId]);
    }
  },
});

/**
 * 审计 §4.1 权威模块（Single Source of Truth）回归测试。
 *
 * 这三条取数能力是 VULN-02 / VULN-07 全部门控的底座：列表 SQL 谓词、写入路径
 * 单条判定、以及竞赛维度（客观题赛期屏蔽）的"未结束"集合。任何一条口径漂移都会
 * 让门控静默失效，故逐条钉住。
 */
Deno.test({
  name:
    "problem-secrecy: 单条判定与 SQL 谓词口径一致（running / pending / ended / invite）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-authority");
    const runningProblem = await createProblem("authority-running");
    const pendingProblem = await createProblem("authority-pending");
    const endedProblem = await createProblem("authority-ended");
    const inviteProblem = await createProblem("authority-invite");
    const runningId = await createContestWith("authority-running", {
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [runningProblem],
      creatorId,
    });
    const pendingId = await createContestWith("authority-pending", {
      startOffsetMs: 60_000,
      endOffsetMs: 120_000,
      problemIds: [pendingProblem],
      creatorId,
    });
    const endedId = await createContestWith("authority-ended", {
      startOffsetMs: -120_000,
      endOffsetMs: -60_000,
      problemIds: [endedProblem],
      creatorId,
    });
    const inviteId = await createContestWith("authority-invite", {
      kind: "invite",
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [inviteProblem],
      creatorId,
    });
    const all = [runningProblem, pendingProblem, endedProblem, inviteProblem];
    try {
      // 内存单条判定
      assertEquals(await isProblemInUnendedPublicContest(runningProblem), true);
      // 赛前筹备期（pending）同样保密——VULN-02 的核心破口正是这里被放行
      assertEquals(await isProblemInUnendedPublicContest(pendingProblem), true);
      assertEquals(await isProblemInUnendedPublicContest(endedProblem), false);
      assertEquals(await isProblemInUnendedPublicContest(inviteProblem), false);

      // SQL 谓词（列表过滤用）必须给出同一答案
      const rows = await getDb().select({
        id: problems.id,
        hidden: sql<boolean>`${unendedPublicContestForProblem(problems.id)}`,
      }).from(problems).where(inArrayIds(all));
      const byId = new Map(rows.map((row) => [row.id, row.hidden]));
      assertEquals(byId.get(runningProblem), true);
      assertEquals(byId.get(pendingProblem), true);
      assertEquals(byId.get(endedProblem), false);
      assertEquals(byId.get(inviteProblem), false);
    } finally {
      await cleanup(
        [runningId, pendingId, endedId, inviteId],
        all,
        [creatorId],
      );
    }
  },
});

Deno.test({
  name:
    "problem-secrecy: filterUnendedContestIds 对竞赛维度给出 running+pending 集合",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ps-unended-ids");
    // 竞赛创建要求至少一道题目，故每场各挂一题
    const runningProblem = await createProblem("ids-running");
    const pendingProblem = await createProblem("ids-pending");
    const endedProblem = await createProblem("ids-ended");
    const runningId = await createContestWith("ids-running", {
      startOffsetMs: -60_000,
      endOffsetMs: 60_000,
      problemIds: [runningProblem],
      creatorId,
    });
    const pendingId = await createContestWith("ids-pending", {
      startOffsetMs: 60_000,
      endOffsetMs: 120_000,
      problemIds: [pendingProblem],
      creatorId,
    });
    const endedId = await createContestWith("ids-ended", {
      startOffsetMs: -120_000,
      endOffsetMs: -60_000,
      problemIds: [endedProblem],
      creatorId,
    });
    try {
      const unended = await filterUnendedContestIds([
        runningId,
        pendingId,
        endedId,
      ]);
      assertEquals(unended.has(runningId), true);
      assertEquals(unended.has(pendingId), true);
      assertEquals(unended.has(endedId), false);
      // 空输入不产生查询，返回空集合
      assertEquals((await filterUnendedContestIds([])).size, 0);
      // 不存在的竞赛 id：无法证明已结束 → fail-closed 视为未结束
      assertEquals(
        (await filterUnendedContestIds([
          "00000000-0000-0000-0000-000000000000",
        ]))
          .size,
        1,
      );
    } finally {
      await cleanup(
        [runningId, pendingId, endedId],
        [runningProblem, pendingProblem, endedProblem],
        [creatorId],
      );
    }
  },
});
