/**
 * 难度校准、达标判定、阶梯与「下一题」测试
 * （真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 覆盖：校准公式（少样本≈先验、多样本≈数据）、达标判定（客观题满分 /
 * 比例覆盖 / 进行中比赛不计）、阶梯排序与可访问性 / 保护过滤、
 * next（未登录 / 部分达标 / 全部达标）、题目页 next、周期任务互斥。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createApp } from "../../app.ts";
import { initRedisForTest, jsonRequest } from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  knowledgeAreas,
  knowledgeNodes,
  knowledgePacks,
  problemDifficulty,
  problemKnowledge,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../shared/db/schema.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { _resetBanCacheForTest } from "../../modules/access/identity/services/security/banCache.ts";
import { signToken as signLiveToken } from "../../modules/access/identity/services/security/jwt.ts";
import {
  addDomainMember,
  createDomain,
  setMemberRole,
} from "../../modules/access/workspace/index.ts";
import {
  calibrateDifficulty,
  isPassingScore,
  loadPassedProblems,
  passRatio,
  passScoreOf,
  PRIOR_STRENGTH,
  readNextForProblem,
  readNodeLadder,
  recalibrateProblem,
  resolvePassScore,
  runExclusiveRecalibration,
  tierOf,
} from "./difficulty.ts";

await resetDbForTest();
await initRedisForTest();

const admin = () => userActorFromAuthenticatedId("0");

async function tokenFor(sub: string, role: string): Promise<string> {
  const token = await signLiveToken({ sub, role }, {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  _resetBanCacheForTest();
  return token;
}

Deno.test("knowledge difficulty: 校准公式少样本≈先验、多样本≈数据", () => {
  // 无样本：等于先验。
  assertEquals(calibrateDifficulty(75, 0, 0).calibrated, 75);
  // 样本远小于 k：贴近先验。
  const few = calibrateDifficulty(25, 2, 0).calibrated;
  const prior = calibrateDifficulty(25, 0, 0).calibrated;
  assertEquals(prior, 25);
  assertEquals(
    Math.abs(few - prior) < Math.abs(few - 100) / 3,
    true,
    `少样本应贴近先验，实际 ${few}`,
  );
  // 样本远大于 k：贴近 d_data（全部达标 → 0）。
  assertEquals(calibrateDifficulty(75, 1000, 1000).calibrated, 1);
  // 全部不达标 → 接近 100。
  assertEquals(calibrateDifficulty(25, 1000, 0).calibrated, 99);
  // 精确公式校验：k=20, prior=25, n=20, passed=0 → d=100 → 62.5 → 63。
  assertEquals(PRIOR_STRENGTH, 20);
  assertEquals(calibrateDifficulty(25, 20, 0).calibrated, 63);
  // 三档派生：<34 easy、<67 medium、其余 hard。
  assertEquals(tierOf(0), "easy");
  assertEquals(tierOf(33), "easy");
  assertEquals(tierOf(34), "medium");
  assertEquals(tierOf(66), "medium");
  assertEquals(tierOf(67), "hard");
  assertEquals(tierOf(100), "hard");
});

Deno.test("knowledge difficulty: 达标判定（客观题满分、比例覆盖、进行中比赛不计）", async () => {
  await resetDbForTest();
  await updateSetting("knowledge_pass_ratio", 60, admin());
  await updateSetting("domain_creation_policy", "open", admin());
  assertEquals(passRatio(), 60);
  const db = getDb();
  const now = new Date().toISOString();
  await updateSetting("domain_creation_policy", "open", admin());
  const domain = await createDomain({
    slug: "kg-diff-a",
    name: "难度校准",
    preset: "community",
  }, "0");
  // 邻接点：仅用于模拟节点挂载（本用例只统计读写与达标人数）。
  const nodeId = await ensureTestNode();
  assertEquals(typeof nodeId, "string");
  const makeProblem = async (
    number: number,
    extra: { is_objective?: boolean } = {},
  ) => {
    const id = crypto.randomUUID();
    await db.insert(problems).values({
      id,
      domain_id: domain.id,
      number,
      title: `题 ${number}`,
      description: "",
      owner_id: "0",
      is_objective: extra.is_objective ?? false,
      difficulty: "medium",
      created_at: now,
      updated_at: now,
    });
    return id;
  };
  const p1 = await makeProblem(1);
  const p2 = await makeProblem(2);
  // 比例覆盖：p2 及格线 90%。非客观题满分经 evaluateScoreScale 前按 10000 记分。
  await db.insert(problemDifficulty).values({
    problem_id: p2,
    prior: 50,
    calibrated: 50,
    sample_size: 0,
    pass_ratio_override: 90,
    updated_at: now,
  });
  assertEquals(
    passScoreOf({ is_objective: false, pass_ratio_override: null }),
    6000,
  );
  assertEquals(
    resolvePassScore({
      is_objective: true,
      pass_ratio_override: null,
      full_score: 300,
    }),
    300,
  );
  assertEquals(
    isPassingScore(6000, { is_objective: false, pass_ratio_override: null }),
    true,
  );
  assertEquals(
    isPassingScore(5999, { is_objective: false, pass_ratio_override: null }),
    false,
  );
  assertEquals(
    isPassingScore(9000, { is_objective: false, pass_ratio_override: 90 }),
    true,
  );
  assertEquals(
    isPassingScore(8000, {
      is_objective: true,
      pass_ratio_override: null,
      full_score: 10000,
    }),
    false,
  );

  // 两个用户：userA 练习达标，userB 仅进行中比赛达标（不计入）。
  const nowIso = new Date().toISOString();
  const mkUser = async () => {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      username: id,
      email: `${id}@example.com`,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return id;
  };
  const userA = await mkUser();
  const userB = await mkUser();
  const runningContest = crypto.randomUUID();
  await db.insert(contests).values({
    id: runningContest,
    domain_id: domain.id,
    title: "进行中",
    type: "oi",
    kind: "public",
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    end_time: new Date(Date.now() + 3600_000).toISOString(),
    owner_id: "0",
    created_at: nowIso,
    updated_at: nowIso,
  } as never);
  const mkSubmission = async (
    problemId: string,
    userId: string,
    score: number,
    contestId: string | null = null,
  ) => {
    const submissionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await db.insert(submissions).values({
      id: submissionId,
      domain_id: domain.id,
      domain_problem_binding_id: problemId === p1 ? p1Binding : p2Binding,
      user_id: userId,
      problem_id: problemId,
      contest_id: contestId,
      language: "c",
      code: "",
      created_at: nowIso,
    } as never);
    await db.execute(sql`
      INSERT INTO evaluation_attempts
        (id, submission_id, problem_id, sequence, source, state,
         result_kind, score, accepted, created_at)
      VALUES (${attemptId}, ${submissionId}, ${problemId}, 0, 'initial',
              'finished', 'graded', ${score}, ${score >= 10000}, ${nowIso})
    `);
    // 有效成绩指针最后写（外键指向已存在的尝试行）。
    await db.update(submissions).set({ effective_attempt_id: attemptId })
      .where(eq(submissions.id, submissionId));
  };

  const p1Binding = crypto.randomUUID();
  await db.insert(domainProblemBindings).values({
    id: p1Binding,
    domain_id: domain.id,
    problem_id: p1,
    visibility: "members",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  const p2Binding = crypto.randomUUID();
  await db.insert(domainProblemBindings).values({
    id: p2Binding,
    domain_id: domain.id,
    problem_id: p2,
    visibility: "members",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  await mkSubmission(p1, userA, 7000);
  await mkSubmission(p1, userB, 10000, runningContest);

  const passedA = await loadPassedProblems(userA, [p1, p2]);
  const passedB = await loadPassedProblems(userB, [p1, p2]);
  assertEquals(passedA.has(p1), true);
  // 进行中比赛的满分不计入。
  assertEquals(passedB.has(p1), false);

  // 校准只计 userA。
  const view = await recalibrateProblem(p1);
  assertEquals(view.sample_size, 1);
  // prior=50, n=1, passed=1 → d=0 → (20*50+0)/21 ≈ 47.6 → 48。
  assertEquals(view.score, 48);
  // 覆盖及格线在重算后保留。
  const view2 = await recalibrateProblem(p2);
  assertEquals(view2.pass_ratio_override, 90);
});

/** 确保存在一个测试知识点（内容包未导入时自建 pack/area/node）。 */
let _testNodeId: string | null = null;
async function ensureTestNode(): Promise<string> {
  if (_testNodeId) return _testNodeId;
  const db = getDb();
  const existing = await db.select({ id: knowledgeNodes.id }).from(
    knowledgeNodes,
  ).limit(1);
  if (existing.length > 0) {
    _testNodeId = existing[0]!.id;
    return _testNodeId;
  }
  const now = new Date().toISOString();
  if (
    (await db.select({ id: knowledgePacks.id }).from(knowledgePacks).limit(1))
      .length === 0
  ) {
    await db.insert(knowledgePacks).values(knowledgePacksForTest());
  }
  await db.insert(knowledgeAreas).values({
    id: "test",
    pack_id: "official",
    name: "测试",
    sort: 0,
  }).onConflictDoNothing();
  _testNodeId = "test.node";
  await db.insert(knowledgeNodes).values({
    id: _testNodeId,
    area_id: "test",
    pack_id: "official",
    name: "测试节点",
    summary: "",
    syllabus: [],
    status: "active",
    doc_path: null,
    updated_at: now,
  }).onConflictDoNothing();
  return _testNodeId;
}

/** 阶梯夹具：一个域、三个已发布题目、登录用户。 */
async function ladderFixture(slug: string) {
  const db = getDb();
  await updateSetting("domain_creation_policy", "open", admin());
  const now = new Date().toISOString();
  await updateSetting("domain_creation_policy", "open", admin());
  const domain = await createDomain(
    { slug, name: slug, preset: "community" },
    "0",
  );
  const author = crypto.randomUUID();
  await db.insert(users).values({
    id: author,
    username: author,
    email: `${author}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await addDomainMember(db, domain.id, author);
  // 作者需有题目管理权才能通过 PUT 挂载（与题目编辑权限同一口径）。
  await setMemberRole(domain.slug, "0", author, "educator");
  _resetBanCacheForTest();
  const nodeId = `kg.${slug}`;
  const existingPack = await db.select({ id: knowledgePacks.id }).from(
    knowledgePacks,
  ).limit(1);
  if (existingPack.length === 0) {
    await db.insert(knowledgePacks).values(knowledgePacksForTest());
  }
  await db.insert(knowledgeAreas).values({
    id: slug,
    pack_id: "official",
    name: slug,
    sort: 0,
  }).onConflictDoNothing();
  await db.insert(knowledgeNodes).values({
    id: nodeId,
    area_id: slug,
    pack_id: "official",
    name: "节点",
    summary: "",
    syllabus: [],
    status: "active",
    doc_path: null,
    updated_at: now,
  });
  const bindings = new Map<string, string>();
  const makeProblem = async (
    number: number,
    options: { calibrated?: number; published?: boolean; protected?: boolean } =
      {},
  ) => {
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await db.insert(problems).values({
      id,
      domain_id: domain.id,
      number,
      title: `题 ${number}`,
      description: "",
      owner_id: author,
      difficulty: "medium",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: id,
      version: 1,
      content: {},
      published_at: now,
      published_by: "0",
    } as never);
    if (options.published !== false) {
      await db.update(problems).set({ latest_version_id: versionId }).where(
        eq(problems.id, id),
      );
    }
    const bindingId = crypto.randomUUID();
    bindings.set(id, bindingId);
    await db.insert(domainProblemBindings).values({
      id: bindingId,
      domain_id: domain.id,
      problem_id: id,
      visibility: "members",
      created_by: "0",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemKnowledge).values({
      problem_id: id,
      node_id: nodeId,
      role: "primary",
      source: "human",
      confidence: null,
      version_id: versionId,
      review_status: "confirmed",
      updated_at: now,
    });
    if (options.calibrated !== undefined) {
      await db.insert(problemDifficulty).values({
        problem_id: id,
        prior: options.calibrated,
        calibrated: options.calibrated,
        sample_size: 5,
        updated_at: now,
      });
    }
    return id;
  };
  return { domain, author, nodeId, makeProblem, bindings };
}

/** 内容包行（阶梯夹具共用）。 */
function knowledgePacksForTest(): typeof knowledgePacks.$inferInsert {
  return {
    id: "official",
    name: "官方",
    version: "test",
    license: "CC",
    active: true,
    imported_at: new Date().toISOString(),
  };
}

Deno.test({
  name: "knowledge difficulty: 阶梯排序、可达性过滤与下一题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await updateSetting("knowledge_enabled", true, admin());
    const db = getDb();
    const f = await ladderFixture("kg-ladder");
    const easy = await f.makeProblem(1, { calibrated: 20 });
    const mid = await f.makeProblem(2, { calibrated: 50 });
    const hard = await f.makeProblem(3, { calibrated: 80 });
    // 未发布题目不出现在阶梯。
    await f.makeProblem(4, { calibrated: 10, published: false });

    // 未登录：按难度升序、passed 全 null、next 为第一题。
    const anon = await readNodeLadder(f.nodeId, f.domain.slug, null);
    assertEquals(anon?.items.map((item) => item.problem_id), [easy, mid, hard]);
    assertEquals(
      anon?.items.every((item) => item.passed === null),
      true,
      "passed-null",
    );
    assertEquals(anon?.next?.problem_id, easy, "next-easy");

    // 已达标 mid：next 为难度 ≥ 50 的第一道未达标（hard）。
    const now = new Date().toISOString();
    const submissionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await db.insert(submissions).values({
      id: submissionId,
      domain_id: f.domain.id,
      domain_problem_binding_id: f.bindings.get(mid)!,
      user_id: f.author,
      problem_id: mid,
      language: "c",
      code: "",
      created_at: now,
    } as never);
    await db.execute(sql`
      INSERT INTO evaluation_attempts
        (id, submission_id, problem_id, sequence, source, state,
         result_kind, score, accepted, created_at)
      VALUES (${attemptId}, ${submissionId}, ${mid}, 0, 'initial',
              'finished', 'graded', 7000, false, ${now})
    `);
    await db.update(submissions).set({ effective_attempt_id: attemptId })
      .where(eq(submissions.id, submissionId));
    const viewer = userActorFromAuthenticatedId(f.author);
    const partial = await readNodeLadder(f.nodeId, f.domain.slug, viewer);
    assertEquals(
      partial?.items.find((item) => item.problem_id === mid)?.passed,
      true,
      "mid-passed",
    );
    assertEquals(partial?.next?.problem_id, hard, "next-hard");

    // 题目页 next：easy 的下一题是难度高于本题、用户未达标的第一题
    // （mid 已达标 → 跳到 hard）。
    const nextOfEasy = await readNextForProblem(easy, viewer);
    assertEquals(nextOfEasy?.problem_id, hard, "nextOfEasy");
    // 最高难度题没有下一题。
    assertEquals(await readNextForProblem(hard, viewer), null, "nextHard");

    // 域不存在 → null。
    assertEquals(
      await readNodeLadder(f.nodeId, "no-such-domain", viewer),
      null,
      "noDomain",
    );
  },
});

Deno.test({
  name: "knowledge difficulty: 保密保护期题目从阶梯剔除",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await updateSetting("knowledge_enabled", true, admin());
    const db = getDb();
    const f = await ladderFixture("kg-protect");
    const normal = await f.makeProblem(1, { calibrated: 30 });
    const secret = await f.makeProblem(2, { calibrated: 40 });
    const now = new Date();
    await db.insert(contests).values({
      id: crypto.randomUUID(),
      domain_id: f.domain.id,
      title: "保密赛",
      type: "oi",
      kind: "public",
      secrecy_enabled: true,
      start_time: new Date(now.getTime() + 3600_000).toISOString(),
      end_time: new Date(now.getTime() + 7200_000).toISOString(),
      owner_id: "0",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    } as never);
    const [contest] = await db.select({ id: contests.id }).from(contests);
    const [secretVersion] = await db.select({ id: problemVersions.id }).from(
      problemVersions,
    ).where(eq(problemVersions.problem_id, secret));
    await db.insert(contestProblems).values({
      domain_id: f.domain.id,
      domain_problem_binding_id: f.bindings.get(secret)!,
      contest_id: contest!.id,
      problem_id: secret,
      label: "A",
      score: 100,
      pinned_version_id: secretVersion!.id,
    });
    const view = await readNodeLadder(f.nodeId, f.domain.slug, null);
    assertEquals(view?.items.map((item) => item.problem_id), [normal]);
    // 实例管理员可预览保护期题目。
    const adminView = await readNodeLadder(f.nodeId, f.domain.slug, null, {
      is_admin: true,
    });
    assertEquals(adminView?.items.map((item) => item.problem_id), [
      normal,
      secret,
    ]);
  },
});

Deno.test("knowledge difficulty: 周期任务互斥（advisory lock）", async () => {
  await resetDbForTest();
  // 并发两轮：同一时刻只有一轮执行（另一轮因拿不到事务级锁返回 null）。
  const results = await Promise.all([
    runExclusiveRecalibration(),
    runExclusiveRecalibration(),
  ]);
  assertEquals(results.includes(null), true);
  assertEquals(results.filter((value) => value !== null).length, 1);
});

Deno.test({
  name: "knowledge difficulty: API 阶梯与 next 端点",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await updateSetting("knowledge_enabled", true, admin());
    const f = await ladderFixture("kg-ladder-api");
    const easy = await f.makeProblem(1, { calibrated: 20 });
    const hard = await f.makeProblem(2, { calibrated: 80 });
    const app = createApp();
    const token = await tokenFor(f.author, "user");
    const res = await jsonRequest(
      app,
      `/api/v1/knowledge/nodes/${f.nodeId}/ladder?domain=${f.domain.slug}`,
      { token },
    );
    assertEquals(res.status, 200);
    const data = (await res.json()).data;
    assertEquals(
      data.items.map((item: { problem_id: string }) => item.problem_id),
      [
        easy,
        hard,
      ],
    );
    assertEquals(data.next.problem_id, easy);
    // 缺 domain → 400。
    assertEquals(
      (await jsonRequest(app, `/api/v1/knowledge/nodes/${f.nodeId}/ladder`))
        .status,
      400,
    );
    // 题目页 next：未登录返回难度更高的未达标题。
    const next = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${easy}/next`,
    );
    assertEquals(next.status, 200);
    assertEquals((await next.json()).data.problem_id, hard);
    // 难度随题目归类返回。
    const detail = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${easy}`,
    );
    assertEquals((await detail.json()).data.difficulty, {
      score: 20,
      tier: "easy",
      sample_size: 5,
      pass_ratio_override: null,
    });
    // 编辑者可覆盖及格线；非法值 400。
    const put = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${easy}`,
      {
        method: "PUT",
        token,
        body: {
          primary: f.nodeId,
          pass_ratio_override: 80,
        },
      },
    );
    assertEquals(put.status, 200);
    assertEquals((await put.json()).data.difficulty.pass_ratio_override, 80);
    const bad = await jsonRequest(app, `/api/v1/knowledge/problems/${easy}`, {
      method: "PUT",
      token,
      body: { primary: f.nodeId, pass_ratio_override: 101 },
    });
    assertEquals(bad.status, 400);
    // 清除覆盖。
    const cleared = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${easy}`,
      {
        method: "PUT",
        token,
        body: { primary: f.nodeId, pass_ratio_override: null },
      },
    );
    assertEquals(
      (await cleared.json()).data.difficulty.pass_ratio_override,
      null,
    );
    // 图形接口带 problem_count。
    const graph = await jsonRequest(
      app,
      `/api/v1/knowledge/graph?domain=${f.domain.slug}`,
    );
    const graphData = (await graph.json()).data;
    const node = graphData.nodes.find(
      (item: { id: string }) => item.id === f.nodeId,
    );
    assertEquals(node.problem_count, 2);
    // 台阶仍只有两条，next 逻辑不受覆盖影响。
    assertEquals(data.items.length, 2);
  },
});
