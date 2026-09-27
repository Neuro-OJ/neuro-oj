/**
 * 公开赛保密事实取数测试（DB）。
 *
 * 判定口径：题目被关联到 `kind = 'public'` 且 `now < end_time` 的竞赛 ⇒ 保密；
 * 赛前（pending）也保密，赛后（ended）自动失效，邀请赛（invite）不参与。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  createContest,
  deleteContest,
  loadPublicContestSecrecy,
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
