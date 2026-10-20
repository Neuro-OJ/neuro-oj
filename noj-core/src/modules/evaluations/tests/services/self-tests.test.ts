import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { v2ResultForTest } from "../_versioning-fixtures.ts";
import {
  bindPublishedProblemForTest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { ensureDefaultWorkspace } from "../../../../domains/workspace/index.ts";

import {
  contests,
  problems,
  problemVersions,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  pendingContestTimes,
  seedRunningContest,
} from "../../../../shared/testing/contest-fixtures.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createSelfTest,
  getSelfTest,
  listMySelfTests,
  saveSelfTestResult,
} from "../../index.ts";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";
import type { JudgeResult } from "../../index.ts";
import type { Context } from "hono";
import { recoverPendingSelfTests } from "../../mq/sweeper.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";

const oldNow = new Date(Date.now() - 3 * 60_000).toISOString();

/** 在假 Redis 环境中跑一次自测恢复，返回主队列消息（JSON）。 */
async function recoverSelfTestsAndReadMessages(): Promise<
  Record<string, unknown>[]
> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    const redis = getRedis();
    await redis.connect();
    await recoverPendingSelfTests(Date.now());
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:high",
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:ai:low",
        "noj:judge:queue:oi-native:medium",
        "noj:judge:queue:oi-wasm:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) {
        messages.push(JSON.parse(raw));
      }
    }
    return messages;
  } finally {
    await fake.stop();
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

const ts = Date.now();
const USER_ID = `tst-st-user-${ts}`;
const PROBLEM_ID = `tst-st-problem-${ts}`;
const OBJECTIVE_PROBLEM_ID = `tst-st-objective-${ts}`;
const SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;

const now = new Date().toISOString();

const runtimeConfig = {
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
};

// 模块级 setup：事务外初始化共享测试数据
await resetDbForTest();
await ensureDefaultWorkspace();
const db = getDb();
await db.insert(users).values({
  id: USER_ID,
  username: `tstst-${ts}`,
  email: `tstst-${ts}@test.noj`,
  password_hash: "hash",
  created_at: now,
  updated_at: now,
});
await db.insert(problems).values([
  {
    domain_id: DEFAULT_DOMAIN_ID,
    id: PROBLEM_ID,
    title: "自测测试题",
    description: "测试描述",
    difficulty: "easy",
    runtime_config: runtimeConfig,
    number: 70000 + (ts % 10000),
    owner_id: USER_ID,
    created_at: now,
    updated_at: now,
  },
  {
    domain_id: DEFAULT_DOMAIN_ID,
    id: OBJECTIVE_PROBLEM_ID,
    title: "客观题套卷",
    description: "客观题",
    difficulty: "easy",
    runtime_config: null,
    is_objective: true,
    number: 80000 + (ts % 10000),
    owner_id: USER_ID,
    created_at: now,
    updated_at: now,
  },
]);

Deno.test({
  name: "self-tests service: 不支持的语言抛出 BadRequestError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      async () =>
        createSelfTest(USER_ID, PROBLEM_ID, {
          version_id: await publishBaselineVersionForTest(PROBLEM_ID),
          language: "ruby",
          code: "puts 1",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "self-tests service: 客观题不支持自测",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSelfTest(USER_ID, OBJECTIVE_PROBLEM_ID, {
          language: "python3",
          code: "print(1)",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "self-tests service: 题目不存在抛出 NotFoundError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSelfTest(USER_ID, "nonexistent-problem", {
          language: "python3",
          code: "print(1)",
        }),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "self-tests service: getSelfTest 不存在抛出 NotFoundError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        getSelfTest(
          "st_nonexistent",
          { var: { userId: USER_ID } } as unknown as Context,
        ),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "self-tests service: saveSelfTestResult 对不存在记录返回 false",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result: JudgeResult = {
      submission_id: "st_unknown",
      status: "finished",
      score: 10000,
      output: "ok",
      details: {},
    };
    const applied = await saveSelfTestResult(await v2ResultForTest(result));
    assertEquals(applied, false);
  },
});

Deno.test({
  name: "self-tests service: saveSelfTestResult 写回且不影响正式表",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.insert(selfTests).values({
      ...await problemExecutionForTest(PROBLEM_ID),
      judge_run_id: "result-self-test-run",
      problem_version_id: await publishBaselineVersionForTest(PROBLEM_ID),
      id: SELF_TEST_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      language: "python3",
      code: "print('hi')",
      status: "judging",
      created_at: now,
    });

    const result: JudgeResult = {
      submission_id: SELF_TEST_ID,
      status: "finished",
      score: 10000,
      output: "---RESULT---\n{}",
      details: { cases: [] },
      time_ms: 12,
      memory_kb: 1024,
    };
    const applied = await saveSelfTestResult(await v2ResultForTest(result));
    assertEquals(applied, true);

    const [row] = await db
      .select()
      .from(selfTests)
      .where(eq(selfTests.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(row.status, "finished");
    assertEquals(row.result_status, "finished");
    assertEquals(row.score, 10000);

    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(sub, undefined);

    // 重复终态结果幂等忽略
    const appliedAgain = await saveSelfTestResult(
      await v2ResultForTest(result),
    );
    assertEquals(appliedAgain, false);
  },
});

/**
 * 面 1.4 审计 F-03 回归：被**未结束公开赛**保密的题目，自测路径必须与详情/模板/
 * 支持包路径同口径返回 **404（NotFoundError）**，而不是 403。
 *
 * 若返回 403，则"403＝存在但保密"与"404＝不存在"的差异本身就是**存在性预言机**
 * ——display_id（P1001 形式）可枚举，攻击者据此即可在赛前确认某题已被某场尚未开始
 * 的公开赛收编。
 */
Deno.test({
  name: "self-tests service: 赛前筹备期保密题返回 404（存在性预言机回归 F-03）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const secretProblemId = `tst-st-secret-${ts}`;
    const secretNow = new Date().toISOString();
    await db.insert(problems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: secretProblemId,
      title: "保密题（不得暴露存在性）",
      description: "题面",
      difficulty: "easy",
      runtime_config: runtimeConfig,
      number: 90000 + (ts % 10000),
      // owner 不是 USER_ID：确保以普通用户身份访问会被拒
      owner_id: "0",
      visibility: "public",
      created_at: secretNow,
      updated_at: secretNow,
    });
    // 加入一场**尚未开始**（pending）的公开赛：最严重的泄密窗口
    const contestId = await seedRunningContest({
      problemIds: [secretProblemId],
      times: pendingContestTimes(),
    });

    // NotFoundError（而非 ForbiddenError）＝对外口径为"题目不存在"
    await assertRejects(
      () =>
        createSelfTest(USER_ID, secretProblemId, {
          language: "python3",
          code: "print(1)",
        }),
      NotFoundError,
    );

    await db.delete(contests).where(eq(contests.id, contestId));
    await deleteProblemFixtures(eq(problems.id, secretProblemId));
  },
});

Deno.test({
  name: "self-tests service: 自测携带版本与执行快照（Handbook §4.2/§5.5）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const problemId = `tst-st-versioned-${ts}`;
    const versionId = `tst-st-versioned-v1-${ts}`;
    const versionConfig = {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 4321,
        memory_limit_mb: 321,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 4321,
        memory_limit_mb: 321,
      },
    };
    await db.insert(problems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: problemId,
      title: "版本化自测题",
      description: "题面",
      difficulty: "easy",
      runtime_config: runtimeConfig,
      number: 91000 + (ts % 5000),
      owner_id: USER_ID,
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: {
        kind: "ai",
        title: "版本化自测题",
        description: "题面",
        samples: [],
        submission_mode: "code",
        runtime_config: versionConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      published_at: now,
    });
    await db.update(problems).set({ latest_version_id: versionId })
      .where(eq(problems.id, problemId));
    await bindPublishedProblemForTest(problemId);

    // 不属于该题的版本：逐字生效（404），不静默换版本
    let code: string | undefined;
    try {
      await createSelfTest(USER_ID, problemId, {
        language: "python3",
        code: "print(1)",
        version_id: `other-${ts}`,
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    assertEquals(code, "PROBLEM_VERSION_NOT_FOUND");

    // 正确版本：落库提交时版本 + 非敏感执行快照（评测队列不可用时也已完成写入）
    await createSelfTest(USER_ID, problemId, {
      language: "python3",
      code: "print(2)",
      version_id: versionId,
    }).catch(() => {/* 评测队列不可用属预期 */});

    const rows = await db.select().from(selfTests).where(
      and(
        eq(selfTests.user_id, USER_ID),
        eq(selfTests.problem_id, problemId),
      ),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].problem_version_id, versionId);
    const snapshot = rows[0].task_snapshot as Record<string, unknown>;
    assertEquals(snapshot.problem_version_id, versionId);
    assertEquals(snapshot.language, "python3");
    assertEquals("eval_token" in snapshot, false);

    await db.delete(selfTests).where(eq(selfTests.problem_id, problemId));
    // 先摘掉最新版指针（复合外键 problems_latest_version_fk），再删版本
    await db.update(problems).set({ latest_version_id: null })
      .where(eq(problems.id, problemId));
    await db.delete(problemVersions).where(eq(problemVersions.id, versionId));
    await deleteProblemFixtures(eq(problems.id, problemId));
  },
});

Deno.test({
  name:
    "self-tests service: 自测按所选版本配置与用例，最新版发布后恢复不漂移（#8）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const problemId = `tst-st-oi-${ts}`;
    const v1 = `tst-st-oi-v1-${ts}`;
    const v2 = `tst-st-oi-v2-${ts}`;
    const v1Config = {
      backend: "native",
      languages: ["c"],
      time_limit_ms: 1111,
      memory_limit_mb: 111,
      checker: { type: "default" },
      subtasks: [],
    };
    const v2Config = {
      ...v1Config,
      time_limit_ms: 9999,
      memory_limit_mb: 999,
    };
    await db.insert(problems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: problemId,
      title: "OI 版本化自测题",
      description: "题面",
      difficulty: "easy",
      judge_type: "oi",
      // 题目投影 = V2：任何"读当前投影"的实现都会拿到 9999
      runtime_config: v2Config,
      number: 92000 + (ts % 1000),
      owner_id: USER_ID,
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values([
      {
        id: v1,
        problem_id: problemId,
        version: 1,
        origin: "published",
        content: {
          kind: "oi",
          title: "OI 版本化自测题",
          description: "题面",
          samples: [{ id: "s1", input: "1", output: "1" }],
          runtime_config: v1Config,
        },
        published_at: now,
      },
      {
        id: v2,
        problem_id: problemId,
        version: 2,
        origin: "published",
        content: {
          kind: "oi",
          title: "OI 版本化自测题",
          description: "题面",
          samples: [{ id: "s2", input: "2", output: "4" }],
          runtime_config: v2Config,
        },
        published_at: now,
      },
    ]);
    await db.update(problems).set({ latest_version_id: v2 }).where(
      eq(problems.id, problemId),
    );
    await bindPublishedProblemForTest(problemId);

    // 显式选择 V1 + 自定义用例（评测队列不可用时记录仍已落库）
    await createSelfTest(USER_ID, problemId, {
      language: "c",
      code: "int main(){return 0;}",
      version_id: v1,
      cases: [{ id: "c1", input: "7", expected_output: "8" }],
    }).catch(() => {/* Redis 不可用属预期 */});

    const [row] = await db.select().from(selfTests).where(
      and(
        eq(selfTests.user_id, USER_ID),
        eq(selfTests.problem_id, problemId),
      ),
    );
    assertEquals(row.problem_version_id, v1);
    const snapshot = row.task_snapshot as Record<string, unknown>;
    // 运行配置来自所选版本 V1，而不是题目最新版投影 V2
    assertEquals(
      (snapshot.runtime_config as { time_limit_ms: number }).time_limit_ms,
      1111,
    );
    // 实际自定义用例被持久化（崩溃恢复的唯一来源）
    const cases = snapshot.self_test_cases as Array<Record<string, unknown>>;
    assertEquals(cases.length, 1);
    assertEquals(cases[0].input, "7");
    assertEquals(cases[0].expected_output, "8");

    // "自测过程中发布 V2"：最新版指针与题目投影都换成 V2
    await db.update(problems).set({
      runtime_config: v2Config,
      latest_version_id: v2,
    }).where(eq(problems.id, problemId));
    // 让恢复窗口生效
    await db.update(selfTests).set({ created_at: oldNow }).where(
      eq(selfTests.id, row.id),
    );

    const messages = await recoverSelfTestsAndReadMessages();
    const task = messages.find((m) => m.submission_id === row.id);
    assertEquals(task !== undefined, true, "自测 pending 必须按快照恢复");
    assertEquals(task!.problem_version_id, v1);
    assertEquals(task!.run_id, row.judge_run_id);
    assertEquals(
      (task!.runtime_config as { time_limit_ms: number }).time_limit_ms,
      1111,
      "恢复必须使用快照中的 V1 配置，不能漂移到最新版",
    );

    // 清理（复合外键：先摘指针再删版本/题目）
    await db.delete(selfTests).where(eq(selfTests.id, row.id));
    await db.update(problems).set({ latest_version_id: null }).where(
      eq(problems.id, problemId),
    );
    await db.delete(problemVersions).where(
      eq(problemVersions.problem_id, problemId),
    );
    await deleteProblemFixtures(eq(problems.id, problemId));
  },
});

Deno.test({
  name: "self-tests service: listMySelfTests 只列本人记录、倒序、不含代码",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const otherUserId = `tst-st-other-${ts}`;
    await db.insert(users).values({
      id: otherUserId,
      username: `tstst-other-${ts}`,
      email: `tstst-other-${ts}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    const older = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
    const newer = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
    const others = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
    await db.insert(selfTests).values([
      {
        id: older,
        ...await problemExecutionForTest(PROBLEM_ID),
        user_id: USER_ID,
        problem_id: PROBLEM_ID,
        language: "ui",
        code: '{"p":"第一轮"}',
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: newer,
        ...await problemExecutionForTest(PROBLEM_ID),
        user_id: USER_ID,
        problem_id: PROBLEM_ID,
        language: "ui",
        code: '{"p":"第二轮"}',
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: others,
        ...await problemExecutionForTest(PROBLEM_ID),
        user_id: otherUserId,
        problem_id: PROBLEM_ID,
        language: "ui",
        code: '{"p":"他人"}',
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ]);
    try {
      const list = await listMySelfTests(USER_ID, PROBLEM_ID, 100);
      const ids = list.map((r) => r.id);
      assertEquals(ids.includes(others), false, "不得列出他人的自测");
      assertEquals(
        ids.indexOf(newer) < ids.indexOf(older),
        true,
        "应按创建时间倒序",
      );
      assertEquals("code" in list[0], false, "列表不应返回代码");

      const limited = await listMySelfTests(USER_ID, PROBLEM_ID, 1);
      assertEquals(limited.length, 1);

      await assertRejects(
        () => listMySelfTests(USER_ID, "nonexistent-problem"),
        NotFoundError,
      );
    } finally {
      await db.delete(selfTests).where(eq(selfTests.id, others));
      await db.delete(users).where(eq(users.id, otherUserId));
    }
  },
});

Deno.test({
  name: "self-tests service: 清理测试数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(selfTests).where(eq(selfTests.user_id, USER_ID));
    await deleteProblemFixtures(eq(problems.id, PROBLEM_ID));
    await deleteProblemFixtures(eq(problems.id, OBJECTIVE_PROBLEM_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
  },
});
