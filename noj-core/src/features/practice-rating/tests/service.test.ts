/**
 * 练习能力值（Best-N Practice Rating）真实 PostgreSQL 集成测试
 * （经 `deno task test:domain practice-rating` 运行）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { initRedisForTest } from "../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { createDomain } from "../../../../tests/helpers/workspace-actors.ts";
import { updateSetting } from "../../../modules/platform/index.ts";
import { userActorFromAuthenticatedId } from "../../../modules/access/contracts/actor.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  objectiveSubmissions,
  problemDifficulty,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { computeProblemRating } from "../formula.ts";
import {
  getPracticeRatingLeaderboard,
  getUserPracticeRating,
} from "../service.ts";

await resetDbForTest();
await initRedisForTest();

const adminActor = () => userActorFromAuthenticatedId("0");

async function createUser(usernamePrefix: string): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `${usernamePrefix}_${id.slice(0, 8)}`,
    email: `${usernamePrefix}_${id.slice(0, 8)}@test.local`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createPublishedProblem(options: {
  domainId?: string;
  number: number;
  title?: string;
  difficulty?: "easy" | "medium" | "hard";
  calibrated?: number;
  isObjective?: boolean;
  objectiveQuestionCount?: number;
  submissionMode?: "code" | "prediction" | "artifact" | "ui";
}): Promise<{ problemId: string; bindingId: string; versionId: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const domainId = options.domainId ?? DEFAULT_DOMAIN_ID;
  const problemId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const isObjective = options.isObjective ?? false;

  await db.insert(problems).values({
    id: problemId,
    domain_id: domainId,
    number: options.number,
    title: options.title ?? `题目 ${options.number}`,
    description: "",
    owner_id: "0",
    difficulty: options.difficulty ?? "medium",
    is_objective: isObjective,
    submission_mode: options.submissionMode ?? "code",
    created_at: now,
    updated_at: now,
  });

  const content = isObjective
    ? {
      kind: "objective",
      questions: Array.from(
        { length: options.objectiveQuestionCount ?? 3 },
        (_, i) => ({ id: `q${i + 1}`, order: i + 1 }),
      ),
    }
    : { kind: "standard" };

  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content,
    published_at: now,
  });

  await db.update(problems)
    .set({ latest_version_id: versionId })
    .where(eq(problems.id, problemId));

  await db.insert(domainProblemBindings).values({
    id: bindingId,
    domain_id: domainId,
    problem_id: problemId,
    visibility: "public",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });

  if (options.calibrated !== undefined) {
    await db.insert(problemDifficulty).values({
      problem_id: problemId,
      prior: options.calibrated,
      calibrated: options.calibrated,
      sample_size: 25,
      updated_at: now,
    });
  }

  return { problemId, bindingId, versionId };
}

async function addCodeSubmission(options: {
  userId: string;
  problemId: string;
  bindingId: string;
  domainId?: string;
  score: number;
  contestId?: string | null;
  createdAt?: string;
}): Promise<void> {
  const db = getDb();
  const now = options.createdAt ?? new Date().toISOString();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();

  await db.insert(submissions).values({
    id: submissionId,
    domain_id: options.domainId ?? DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: options.bindingId,
    user_id: options.userId,
    problem_id: options.problemId,
    contest_id: options.contestId ?? null,
    language: "python",
    code: "print(1)",
    is_valid: true,
    is_accepted: options.score >= 10000,
    created_at: now,
  } as never);

  await db.execute(sql`
    INSERT INTO evaluation_attempts
      (id, submission_id, problem_id, sequence, source, state,
       result_kind, score, accepted, created_at, finished_at)
    VALUES (
      ${attemptId}, ${submissionId}, ${options.problemId}, 0, 'initial',
      'finished', 'graded', ${options.score}, ${options.score >= 10000},
      ${now}, ${now}
    )
  `);

  await db.update(submissions)
    .set({ effective_attempt_id: attemptId })
    .where(eq(submissions.id, submissionId));
}

async function addObjectiveSubmission(options: {
  userId: string;
  problemId: string;
  bindingId: string;
  score: number;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const objSubId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();

  await db.insert(objectiveSubmissions).values({
    id: objSubId,
    domain_id: DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: options.bindingId,
    user_id: options.userId,
    paper_id: options.problemId,
    submission_type: "practice",
    answers: {},
    is_valid: true,
    is_accepted: false,
    created_at: now,
  } as never);

  await db.execute(sql`
    INSERT INTO evaluation_attempts
      (id, objective_submission_id, problem_id, sequence, source, state,
       result_kind, score, accepted, created_at, finished_at)
    VALUES (
      ${attemptId}, ${objSubId}, ${options.problemId}, 0, 'initial',
      'finished', 'graded', ${options.score}, FALSE,
      ${now}, ${now}
    )
  `);

  await db.update(objectiveSubmissions)
    .set({ effective_attempt_id: attemptId })
    .where(eq(objectiveSubmissions.id, objSubId));
}

Deno.test({
  name:
    "practice-rating service: 不存在用户抛 NotFoundError，无记录返回 unrated",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => getUserPracticeRating(crypto.randomUUID()),
      NotFoundError,
    );

    const userId = await createUser("pr_empty");
    const empty = await getUserPracticeRating(userId);
    assertEquals(empty.rating, 0);
    assertEquals(empty.tier, "unrated");
    assertEquals(empty.counted_problems, 0);
    assertEquals(empty.floor_rating, null);
    assertEquals(empty.rank, null);
    assertEquals(empty.entries.length, 0);
  },
});

Deno.test({
  name: "practice-rating service: 连续分制刷高补差、客观题满分与校准难度回退",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userId = await createUser("pr_score");

    // 1. 预测题（有校准难度 80）：先拿 60%，再刷到 90%
    const pred = await createPublishedProblem({
      number: 2001,
      title: "预测题 A",
      difficulty: "medium",
      calibrated: 80,
      submissionMode: "prediction",
    });
    await addCodeSubmission({
      userId,
      problemId: pred.problemId,
      bindingId: pred.bindingId,
      score: 6000,
    });
    const before = await getUserPracticeRating(userId);
    const expectedBefore = computeProblemRating({
      difficulty: 80,
      score: 6000,
      fullScore: 10000,
    }).problemRating;
    assertEquals(before.rating, expectedBefore);
    assertEquals(before.entries[0].is_calibrated, true);
    assertEquals(before.entries[0].effective_difficulty, 80);

    // 刷新到 90%：只按最高分计，不重复叠加
    await addCodeSubmission({
      userId,
      problemId: pred.problemId,
      bindingId: pred.bindingId,
      score: 9000,
    });
    // 再提交一个更低的 50%：不影响最高分
    await addCodeSubmission({
      userId,
      problemId: pred.problemId,
      bindingId: pred.bindingId,
      score: 5000,
    });

    // 2. 客观题套卷（无校准行，回退 hard=75；4 小题满分 400，得 300）
    const obj = await createPublishedProblem({
      number: 2002,
      title: "客观题 B",
      difficulty: "hard",
      isObjective: true,
      objectiveQuestionCount: 4,
    });
    await addObjectiveSubmission({
      userId,
      problemId: obj.problemId,
      bindingId: obj.bindingId,
      score: 300,
    });

    const after = await getUserPracticeRating(userId);
    const predRating = computeProblemRating({
      difficulty: 80,
      score: 9000,
      fullScore: 10000,
    }).problemRating;
    const objRating = computeProblemRating({
      difficulty: 75,
      score: 300,
      fullScore: 400,
    }).problemRating;

    assertEquals(after.counted_problems, 2);
    assertEquals(after.rating, predRating + objRating);
    assertEquals(after.entries[0].problem_id, pred.problemId);
    assertEquals(after.entries[0].best_score, 9000);
    assertEquals(after.entries[1].problem_id, obj.problemId);
    assertEquals(after.entries[1].is_calibrated, false);
    assertEquals(after.entries[1].full_score, 400);
    assertEquals(after.entries[1].best_score, 300);
  },
});

Deno.test({
  name:
    "practice-rating service: 防刷边界（排除私有域题与进行中保密赛，纳入已结束赛，B30免疫水题）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await updateSetting("domain_creation_policy", "open", adminActor());
    const db = getDb();
    const now = new Date().toISOString();
    const userId = await createUser("pr_guard");

    // 1. 团队私有域自建 hard 题：绝不能计入全站练习能力值
    const teamDomain = await createDomain({
      slug: "pr-private-team",
      name: "私有团队域",
      preset: "team",
    }, "0");
    const privateProblem = await createPublishedProblem({
      domainId: teamDomain.id,
      number: 1001,
      difficulty: "hard",
      calibrated: 99,
    });
    await addCodeSubmission({
      userId,
      domainId: teamDomain.id,
      problemId: privateProblem.problemId,
      bindingId: privateProblem.bindingId,
      score: 10000,
    });

    // 2. 主域未结束保密公开赛题目：严禁计入
    const secretProblem = await createPublishedProblem({
      number: 3001,
      difficulty: "hard",
      calibrated: 95,
    });
    const runningContestId = crypto.randomUUID();
    await db.insert(contests).values({
      id: runningContestId,
      domain_id: DEFAULT_DOMAIN_ID,
      title: "进行中保密公开赛",
      type: "oi",
      kind: "public",
      secrecy_enabled: true,
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      owner_id: "0",
      created_at: now,
      updated_at: now,
    } as never);
    await db.insert(contestProblems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: secretProblem.bindingId,
      contest_id: runningContestId,
      problem_id: secretProblem.problemId,
      pinned_version_id: secretProblem.versionId,
      sort_order: 1,
      label: "A",
      score: 100,
    } as never);
    await addCodeSubmission({
      userId,
      problemId: secretProblem.problemId,
      bindingId: secretProblem.bindingId,
      contestId: runningContestId,
      score: 10000,
    });

    // 3. 主域已结束比赛题目：应计入
    const endedProblem = await createPublishedProblem({
      number: 3002,
      difficulty: "hard",
      calibrated: 75,
    });
    const endedContestId = crypto.randomUUID();
    await db.insert(contests).values({
      id: endedContestId,
      domain_id: DEFAULT_DOMAIN_ID,
      title: "已结束公开赛",
      type: "oi",
      kind: "public",
      secrecy_enabled: true,
      start_time: new Date(Date.now() - 7200_000).toISOString(),
      end_time: new Date(Date.now() - 3600_000).toISOString(),
      owner_id: "0",
      created_at: now,
      updated_at: now,
    } as never);
    await addCodeSubmission({
      userId,
      problemId: endedProblem.problemId,
      bindingId: endedProblem.bindingId,
      contestId: endedContestId,
      score: 10000,
    });

    // 再补齐 29 道主域 hard 题（合计 30 道 hard），加 1 道 easy 水题
    for (let i = 0; i < 29; i++) {
      const p = await createPublishedProblem({
        number: 3100 + i,
        difficulty: "hard",
        calibrated: 75,
      });
      await addCodeSubmission({
        userId,
        problemId: p.problemId,
        bindingId: p.bindingId,
        score: 10000,
      });
    }
    const easyWater = await createPublishedProblem({
      number: 3200,
      difficulty: "easy",
      calibrated: 25,
    });
    await addCodeSubmission({
      userId,
      problemId: easyWater.problemId,
      bindingId: easyWater.bindingId,
      score: 10000,
    });

    const result = await getUserPracticeRating(userId);
    const hardRating = computeProblemRating({
      difficulty: 75,
      score: 10000,
      fullScore: 10000,
    }).problemRating;

    assertEquals(result.counted_problems, 30);
    assertEquals(result.total_scored_problems, 31);
    assertEquals(result.rating, 30 * hardRating);
    assertEquals(result.floor_rating, hardRating);
    assertEquals(
      result.entries.some((e) =>
        e.problem_id === privateProblem.problemId ||
        e.problem_id === secretProblem.problemId ||
        e.problem_id === easyWater.problemId
      ),
      false,
    );
    assertEquals(
      result.entries.some((e) => e.problem_id === endedProblem.problemId),
      true,
    );
  },
});

Deno.test({
  name: "practice-rating service: 全站能力值榜排序、root剔除及 SQL/TS 一致性",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const userHigh = await createUser("pr_high");
    const userMid = await createUser("pr_mid");

    const pHard = await createPublishedProblem({
      number: 4001,
      difficulty: "hard",
      calibrated: 83,
    });
    const pMed = await createPublishedProblem({
      number: 4002,
      difficulty: "medium",
      calibrated: 47,
    });

    // root 也提交满分，不应出现在全站榜中
    await addCodeSubmission({
      userId: "0",
      problemId: pHard.problemId,
      bindingId: pHard.bindingId,
      score: 10000,
    });
    await addCodeSubmission({
      userId: userHigh,
      problemId: pHard.problemId,
      bindingId: pHard.bindingId,
      score: 9123,
    });
    await addCodeSubmission({
      userId: userHigh,
      problemId: pMed.problemId,
      bindingId: pMed.bindingId,
      score: 7777,
    });
    await addCodeSubmission({
      userId: userMid,
      problemId: pMed.problemId,
      bindingId: pMed.bindingId,
      score: 8888,
    });

    const highProfile = await getUserPracticeRating(userHigh);
    const midProfile = await getUserPracticeRating(userMid);
    const rootProfile = await getUserPracticeRating("0");
    assertEquals(rootProfile.rank, null);

    const board = await getPracticeRatingLeaderboard(1, 50, userMid);
    assertEquals(board.total, 2);
    assertEquals(board.data.length, 2);
    assertEquals(board.data[0].user_id, userHigh);
    assertEquals(board.data[0].rank, 1);
    // 严格断言 SQL 聚合值与 TS 纯函数计算值完全一致
    assertEquals(board.data[0].rating, highProfile.rating);
    assertEquals(board.data[1].user_id, userMid);
    assertEquals(board.data[1].rank, 2);
    assertEquals(board.data[1].rating, midProfile.rating);
    assertEquals(board.user_rank, 2);
    assertEquals(board.user_rating, midProfile.rating);
    assertEquals(highProfile.rank, 1);
    assertEquals(midProfile.rank, 2);
  },
});
