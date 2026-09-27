/**
 * 取数+判定入口 `evaluateProblemAccess*` 的 DB 级测试（2026-09-26）。
 *
 * 重点覆盖"客观题套卷竞赛路径"依赖的那条豁免：题目虽被公开赛保密，但**持有有效
 * 竞赛上下文**（是该竞赛参赛者、题目属于该竞赛、窗口 running/ended）时仍放行——
 * 这条豁免决定了 `GET /:id/questions?contest_id=` 不会在赛中失效。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import { createProblem } from "../../index.ts";
import {
  evaluateProblemAccess,
  evaluateProblemAccessWithContestId,
} from "../../services/problem-access-check.ts";
import {
  createContest,
  deleteContest,
  registerForContest,
} from "../../../contest/index.ts";

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

async function createOwnedPublicProblem(ownerId: string): Promise<string> {
  const created = await createProblem({
    title: `访问判定入口测试题 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    description: "题面",
    difficulty: "easy",
    type: "U",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
  });
  await getDb()
    .update(problems)
    .set({
      visibility: "public",
      owner_id: ownerId,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, created.id));
  return created.id;
}

async function linkToContest(
  problemId: string,
  creatorId: string,
  startOffsetMs: number,
  endOffsetMs: number,
): Promise<string> {
  const contest = await createContest(
    {
      title: `访问判定 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      start_time: new Date(Date.now() + startOffsetMs).toISOString(),
      end_time: new Date(Date.now() + endOffsetMs).toISOString(),
      type: "kaggle",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
    creatorId,
    true,
  );
  return contest.id;
}

async function cleanupProblemAndContest(
  contestId: string,
  problemId: string,
): Promise<void> {
  await deleteContest(contestId).catch(() => {});
  await getDb().delete(problems).where(eq(problems.id, problemId)).catch(
    () => {},
  );
}

Deno.test({
  name: "problem-access-check: 保密题无上下文 → denied，并返回关联竞赛引用",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerId = await createUser("pac-owner-1");
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(
      problemId,
      ownerId,
      -60_000,
      3_600_000,
    );
    const problem = { id: problemId, visibility: "public", owner_id: ownerId };
    try {
      const { result, secrecy } = await evaluateProblemAccess(problem, {
        viewerId: null,
        isAdmin: false,
      });
      assertEquals(result, { allowed: false, mode: "contest-secret" });
      assertEquals(secrecy.map((ref) => ref.contestId), [contestId]);
    } finally {
      await cleanupProblemAndContest(contestId, problemId);
    }
  },
});

Deno.test({
  name:
    "problem-access-check: 保密题 + running 公开赛参赛者上下文 → 放行（objective 竞赛路径）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerId = await createUser("pac-owner-2");
    const participantId = await createUser("pac-part-2");
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(
      problemId,
      ownerId,
      -60_000,
      3_600_000,
    );
    const problem = { id: problemId, visibility: "public", owner_id: ownerId };
    try {
      await registerForContest(contestId, participantId);
      const { result } = await evaluateProblemAccessWithContestId(problem, {
        viewerId: participantId,
        isAdmin: false,
        contestId,
      });
      assertEquals(result, { allowed: true, mode: "contest" });
    } finally {
      await cleanupProblemAndContest(contestId, problemId);
    }
  },
});

Deno.test({
  name: "problem-access-check: 保密题 + 非参赛者伪造 contest_id → denied",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerId = await createUser("pac-owner-3");
    const strangerId = await createUser("pac-stranger-3");
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(
      problemId,
      ownerId,
      -60_000,
      3_600_000,
    );
    const problem = { id: problemId, visibility: "public", owner_id: ownerId };
    try {
      const { result } = await evaluateProblemAccessWithContestId(problem, {
        viewerId: strangerId,
        isAdmin: false,
        contestId,
      });
      assertEquals(result.allowed, false);
    } finally {
      await cleanupProblemAndContest(contestId, problemId);
    }
  },
});

Deno.test({
  name: "problem-access-check: 竞赛已结束 → 保密失效，回到 public 判定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerId = await createUser("pac-owner-4");
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(
      problemId,
      ownerId,
      -7_200_000,
      -3_600_000,
    );
    const problem = { id: problemId, visibility: "public", owner_id: ownerId };
    try {
      const { result, secrecy } = await evaluateProblemAccess(problem, {
        viewerId: null,
        isAdmin: false,
      });
      assertEquals(result, { allowed: true, mode: "public" });
      assertEquals(secrecy, []);
    } finally {
      await cleanupProblemAndContest(contestId, problemId);
    }
  },
});

Deno.test({
  name: "problem-access-check: owner 与 admin 不受保密影响（横幅数据仍可取）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerId = await createUser("pac-owner-5");
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(
      problemId,
      ownerId,
      -60_000,
      3_600_000,
    );
    const problem = { id: problemId, visibility: "public", owner_id: ownerId };
    try {
      const owner = await evaluateProblemAccess(problem, {
        viewerId: ownerId,
        isAdmin: false,
      });
      assertEquals(owner.result, { allowed: true, mode: "owner" });
      assertEquals(owner.secrecy.length, 1);

      const admin = await evaluateProblemAccess(problem, {
        viewerId: await createUser("pac-admin-5"),
        isAdmin: true,
      });
      assertEquals(admin.result.mode, "admin");
      assertEquals(admin.secrecy.length, 1);

      // 竞赛结束后横幅数据为空（前端据此不渲染提示）
      await getDb()
        .update(contests)
        .set({ end_time: new Date(Date.now() - 1000).toISOString() })
        .where(eq(contests.id, contestId));
      const afterEnd = await evaluateProblemAccess(problem, {
        viewerId: ownerId,
        isAdmin: false,
      });
      assertEquals(afterEnd.secrecy, []);
    } finally {
      await cleanupProblemAndContest(contestId, problemId);
    }
  },
});
