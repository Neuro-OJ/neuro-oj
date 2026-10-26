import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
/**
 * 竞赛固定版本读取与版本策略回归（Handbook §2.6/§4.1/§4.5）。
 *
 * 覆盖缺陷：
 * - **#2-contest**：竞赛题面与派生字段（题型、评测后端、支持语言、提交模式、
 *   产物上限）必须由 `contest_problems.pinned_version_id` 的**版本内容**计算，
 *   而不是 `problems` 投影（"最新版"口径）。否则出现"版本号说 V1、内容却是 V2"。
 * - **#44**：保存竞赛题目列表（整体替换）不得重置已有 `exact` 策略、要求版本与
 *   `effective_policy_revision`（策略只能经专门服务改变）。
 * - **#45**：竞赛榜单按**竞赛口径有效成绩指针**计分，版本策略 any → exact 切换
 *   后立即改用新目标版本的判定，不吃"最近分数"。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createContest,
  getContestProblems,
  getContestRankingView,
  updateContest,
} from "../../index.ts";
import { getContestRanking } from "../../services/contest-ranking.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";

await resetDbForTest({ refreshRankings: true });

const baseTime = Date.now() - 3_600_000;
const atMinutes = (minutes: number) =>
  new Date(baseTime + minutes * 60_000).toISOString();
const now = new Date().toISOString();

async function insertUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
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

/** 插入题目身份行（管理信息：难度/可见性等）。 */
async function insertProblemRow(
  id: string,
  number: number,
  options: {
    judgeType?: "dual" | "oi";
    runtimeConfig?: unknown;
    difficulty?: string;
    title?: string;
  } = {},
): Promise<void> {
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    title: options.title ?? `题目身份-${number}`,
    description: "身份描述（非版本内容）",
    difficulty: options.difficulty ?? "easy",
    runtime_config: (options.runtimeConfig ?? null) as never,
    judge_type: options.judgeType ?? "dual",
    number,
    owner_id: "0",
    created_at: now,
    updated_at: now,
  });
}

/** 插入一个已发布版本。 */
async function insertVersion(
  problemId: string,
  versionId: string,
  version: number,
  content: unknown,
): Promise<void> {
  await getDb().insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version,
    schema_version: 1,
    origin: "published",
    content: content as never,
    content_sha256: `sha-${versionId}`,
    published_at: now,
  });
}

/** 一份 OI 版本内容（语言/后端随版本固定）。 */
function oiContent(
  title: string,
  backend: "native" | "wasm",
  languages: Array<"c" | "cc">,
) {
  return {
    kind: "oi",
    title,
    description: `${title} 描述`,
    samples: [{ id: "sample", input: backend, output: title }],
    runtime_config: {
      backend,
      languages,
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [{ id: "1", score: 100, cases: [] }],
    },
  };
}

Deno.test({
  name:
    "contest version(#2): 题面与派生字段取竞赛固定版本内容，而非 problems 投影",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = await insertUser("cver-admin");
    const problemId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const versionV1 = `${problemId}-v1`;
    const versionV2 = `${problemId}-v2`;

    // 题目行投影："最新版"口径 = V2（wasm + c）
    await insertProblemRow(problemId, 921001, {
      judgeType: "oi",
      runtimeConfig: oiContent("投影", "wasm", ["c"]).runtime_config,
    });
    await insertVersion(
      problemId,
      versionV1,
      1,
      oiContent("V1 题面", "native", [
        "cc",
      ]),
    );
    await insertVersion(
      problemId,
      versionV2,
      2,
      oiContent("V2 题面", "wasm", [
        "c",
      ]),
    );
    await db.update(problems).set({ latest_version_id: versionV2 }).where(
      eq(problems.id, problemId),
    );
    await bindPublishedProblemForTest(problemId);

    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      title: "固定版本读取测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(120),
      type: "kaggle",
      config: {},
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });
    // 竞赛固定 V1（题库最新版是 V2）：这是缺陷 #2 的核心场景
    await insertContestProblems({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionV1,
      effective_version_mode: "exact",
      required_version_id: versionV1,
      effective_policy_revision: 3,
    });

    try {
      const list = await getContestProblems(contestId);
      const row = list.find((item) => item.problem_id === problemId);
      assertExists(row);
      // 题面取固定版本
      assertEquals(row.title, "V1 题面");
      assertEquals(row.description, "V1 题面 描述");
      // 派生字段同样由固定版本计算：V1 = native + cc
      assertEquals(row.judge_type, "oi");
      assertEquals(row.judge_backend, "oi-native");
      assertEquals(row.supported_languages, ["cc"]);
      assertEquals(row.samples, [{
        id: "sample",
        input: "native",
        output: "V1 题面",
      }]);
      assertEquals(row.limits, { time_limit_ms: 1000, memory_limit_mb: 256 });
      // 管理信息（难度）仍取题目身份
      assertEquals(row.difficulty, "easy");
      // 版本与策略元数据
      assertEquals(row.version_id, versionV1);
      assertEquals(row.version, 1);
      assertEquals(row.effective_version_policy, {
        mode: "exact",
        version_id: versionV1,
      });
      assertEquals(row.effective_version_policy_revision, 3);

      // 固定版本升级为 V2 后，题面与派生字段随固定版本变化（不是 problems 投影）
      await db.update(contestProblems).set({
        pinned_version_id: versionV2,
        required_version_id: versionV2,
      }).where(
        and(
          eq(contestProblems.contest_id, contestId),
          eq(contestProblems.problem_id, problemId),
        ),
      );
      const upgraded = (await getContestProblems(contestId)).find(
        (item) => item.problem_id === problemId,
      );
      assertExists(upgraded);
      assertEquals(upgraded.title, "V2 题面");
      assertEquals(upgraded.judge_backend, "oi-wasm");
      assertEquals(upgraded.supported_languages, ["c"]);
      assertEquals(upgraded.samples, [{
        id: "sample",
        input: "wasm",
        output: "V2 题面",
      }]);
      assertEquals(upgraded.version, 2);
    } finally {
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, adminId));
    }
  },
});

Deno.test({
  name:
    "contest version(#44): 保存竞赛题目列表保留 exact 策略、要求版本与策略 revision",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = await insertUser("cpolicy-admin");
    const problemId = crypto.randomUUID();
    const otherProblemId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const versionV1 = `${problemId}-v1`;

    await insertProblemRow(problemId, 921010);
    await insertVersion(problemId, versionV1, 1, {
      kind: "ai",
      title: "策略题",
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    });
    await db.update(problems).set({ latest_version_id: versionV1 }).where(
      eq(problems.id, problemId),
    );
    await bindPublishedProblemForTest(problemId);
    await insertProblemRow(otherProblemId, 921011);
    const otherVersion = `${otherProblemId}-v1`;
    await insertVersion(otherProblemId, otherVersion, 1, {
      kind: "ai",
      title: "第二题",
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    });
    await db.update(problems).set({ latest_version_id: otherVersion }).where(
      eq(problems.id, otherProblemId),
    );
    await bindPublishedProblemForTest(otherProblemId);

    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      title: "策略保留测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(120),
      type: "kaggle",
      config: {},
      is_public: true,
      kind: "public",
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });
    await insertContestProblems({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionV1,
      effective_version_mode: "exact",
      required_version_id: versionV1,
      effective_policy_revision: 7,
    });

    try {
      // 保存题目列表：重命名 + 调整顺序/标签（整体替换语义）
      await updateContest(
        contestId,
        {
          title: "策略保留测试（改名）",
          problems: [
            {
              problem_id: problemId,
              label: "B",
              sort_order: 1,
              score: 10000,
            },
            {
              problem_id: otherProblemId,
              label: "A",
              sort_order: 0,
              score: 5000,
            },
          ],
        },
        true,
      );

      const rows = await db.select().from(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      const preserved = rows.find((row) => row.problem_id === problemId);
      assertExists(preserved);
      // 只改标签/排序，策略字段必须原样保留（缺陷 #44）
      assertEquals(preserved.effective_version_mode, "exact");
      assertEquals(preserved.required_version_id, versionV1);
      assertEquals(preserved.pinned_version_id, versionV1);
      assertEquals(preserved.effective_policy_revision, 7);
      assertEquals(preserved.label, "B");
      assertEquals(preserved.sort_order, 1);

      // 新加入的题目按"当前最新版"固定，且策略默认 any/0
      const added = rows.find((row) => row.problem_id === otherProblemId);
      assertExists(added);
      assertEquals(added.pinned_version_id, otherVersion);
      assertEquals(added.effective_version_mode, "any");
      assertEquals(added.required_version_id, null);
      assertEquals(added.effective_policy_revision, 0);

      // 再次保存（顺序回退）仍不得重置策略
      await updateContest(
        contestId,
        {
          problems: [
            {
              problem_id: problemId,
              label: "A",
              sort_order: 0,
              score: 10000,
            },
          ],
        },
        true,
      );
      const after = await db.select().from(contestProblems).where(
        and(
          eq(contestProblems.contest_id, contestId),
          eq(contestProblems.problem_id, problemId),
        ),
      );
      assertEquals(after[0].effective_version_mode, "exact");
      assertEquals(after[0].required_version_id, versionV1);
      assertEquals(after[0].effective_policy_revision, 7);
    } finally {
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      for (const id of [problemId, otherProblemId]) {
        await db.update(problems).set({ latest_version_id: null }).where(
          eq(problems.id, id),
        );
        await db.delete(problemVersions).where(
          eq(problemVersions.problem_id, id),
        );
        await deleteProblemFixtures(eq(problems.id, id));
      }
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, adminId));
    }
  },
});

Deno.test({
  name:
    "contest version(#45): 榜单按竞赛有效指针计分——any→exact 切换与跨版本重判",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await insertUser("canyexact-user");
    const problemId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const versionV1 = `${problemId}-v1`;
    const versionV2 = `${problemId}-v2`;
    const submissionId = crypto.randomUUID();
    const attemptV1 = crypto.randomUUID();
    const attemptV2 = crypto.randomUUID();

    await insertProblemRow(problemId, 921020);
    await insertVersion(problemId, versionV1, 1, {
      kind: "ai",
      title: "V1",
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    });
    await insertVersion(problemId, versionV2, 2, {
      kind: "ai",
      title: "V2",
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    });
    await db.update(problems).set({ latest_version_id: versionV2 }).where(
      eq(problems.id, problemId),
    );
    await bindPublishedProblemForTest(problemId);

    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      title: "any/exact 切换测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(-1),
      type: "kaggle",
      config: {},
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    await insertContestProblems({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionV1,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: userId,
      registered_at: atMinutes(-100),
    });
    // 提交时间在赛期内（早于结束时间）
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      ...await problemExecutionForTest(problemId),
      contest_id: contestId,
      language: "python3",
      code: "print(1)",
      status: "finished",
      version_origin: "legacy_unknown",
      created_at: atMinutes(-50),
    });
    // 同一提交在 V1 满分（sequence 0）、V2 零分（sequence 1）各有一次正式判定
    await db.insert(evaluationAttempts).values([
      {
        id: attemptV1,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionV1,
        sequence: 0,
        source: "initial",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: 10000,
        accepted: true,
        created_at: atMinutes(-49),
        finished_at: atMinutes(-49),
      },
      {
        id: attemptV2,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionV2,
        sequence: 1,
        source: "rejudge",
        state: "finished",
        result_kind: "graded",
        // 正式 TLE 也是 graded；字符串不能参与口径判定
        result_status: "TimeLimitExceeded",
        score: 0,
        accepted: false,
        created_at: atMinutes(-30),
        finished_at: atMinutes(-30),
      },
    ]);

    try {
      // any：V1 满分是最佳候选 → 10 分（此处 score 已是 ×100 后的 10000）
      await db.update(submissions).set({
        is_contest_valid: true,
        latest_attempt_id: attemptV2,
        contest_effective_attempt_id: attemptV1,
        effective_attempt_id: attemptV1,
      }).where(eq(submissions.id, submissionId));

      // 已结束且未结算：非管理员只能看本人/匿名被门禁拦截，这里验证计分口径，
      // 因此显式以管理员视角读取全量榜。
      const anyRanking = await getContestRanking(contestId, "kaggle", true);
      assertEquals(anyRanking[0].total_score, 10000);
      // 定性归因：有效尝试 = V1，且提交时间用原始 created_at（不是重测时间）
      const anyDetails = await getContestRankingView(contestId, "kaggle", true);
      const anyScore = anyDetails.rows[0].problem_scores[0];
      assertEquals(anyScore.effective_attempt_id, attemptV1);
      assertEquals(anyScore.evaluated_version_id, versionV1);
      assertEquals(anyScore.last_best_at, atMinutes(-50));

      // 切换为 exact(V2)：投影按新策略把竞赛有效指针改到 V2（否则不得分）
      await db.update(contestProblems).set({
        effective_version_mode: "exact",
        required_version_id: versionV2,
        pinned_version_id: versionV2,
        effective_policy_revision: 1,
      }).where(
        and(
          eq(contestProblems.contest_id, contestId),
          eq(contestProblems.problem_id, problemId),
        ),
      );
      await db.update(submissions).set({
        contest_effective_attempt_id: attemptV2,
      }).where(eq(submissions.id, submissionId));

      const exactRanking = await getContestRanking(contestId, "kaggle", true);
      // exact(V2) 下 V1 满分不再有效 → 只认 V2 的零分判定
      assertEquals(exactRanking[0].total_score, 0);
      const exactDetails = await getContestRankingView(
        contestId,
        "kaggle",
        true,
      );
      const exactScore = exactDetails.rows[0].problem_scores[0];
      assertEquals(exactScore.effective_attempt_id, attemptV2);
      assertEquals(exactScore.evaluated_version_id, versionV2);
      // 归因记录策略快照
      assertEquals(exactScore.version_policy, {
        mode: "exact",
        version_id: versionV2,
      });
      // 提交时间仍是原始提交时间，重测不把旧提交变成赛后提交
      assertEquals(exactScore.last_best_at, atMinutes(-50));
    } finally {
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, problemId),
      );
      await db.delete(submissions).where(eq(submissions.id, submissionId));
      await db.delete(contestParticipants).where(
        eq(contestParticipants.contest_id, contestId),
      );
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, userId));
    }
  },
});

// 保持 createContest 引用：部分场景需要走完整创建路径校验固定版本写入
Deno.test({
  name:
    "contest version(#44): 创建竞赛即固定最新已发布版本（与保存列表口径一致）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = await insertUser("ccreate-admin");
    const problemId = crypto.randomUUID();
    const versionV1 = `${problemId}-v1`;

    await insertProblemRow(problemId, 921030);
    await insertVersion(problemId, versionV1, 1, {
      kind: "ai",
      title: "创建固定题",
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    });
    await db.update(problems).set({ latest_version_id: versionV1 }).where(
      eq(problems.id, problemId),
    );
    await bindPublishedProblemForTest(problemId);

    let contestId: string | undefined;
    try {
      const created = await createContest(
        {
          title: "创建固定版本测试",
          start_time: atMinutes(-10),
          end_time: atMinutes(60),
          type: "kaggle",
          is_public: false,
          kind: "invite",
          password: "invite-code",
          problems: [{
            problem_id: problemId,
            label: "A",
            sort_order: 0,
            score: 10000,
          }],
        },
        adminId,
        true,
      );
      contestId = created.id;

      const rows = await db.select().from(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      assertEquals(rows[0].pinned_version_id, versionV1);
      assertEquals(rows[0].effective_version_mode, "any");
      assertEquals(rows[0].effective_policy_revision, 0);

      const list = await getContestProblems(contestId);
      assertEquals(list[0].title, "创建固定题");
      assertEquals(list[0].version_id, versionV1);
    } finally {
      if (contestId) {
        await db.delete(contestProblems).where(
          eq(contestProblems.contest_id, contestId),
        );
        await db.delete(contests).where(eq(contests.id, contestId));
      }
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, adminId));
    }
  },
});
