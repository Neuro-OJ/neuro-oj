/**
 * 掌握度、推荐、根因诊断与覆盖度测试（真实 PostgreSQL）。
 *
 * 覆盖：掌握规则各分支（learning / mastered / 题量 < K / 上三分之一难度）、
 * 进行中比赛不计、保护结束后计入、成绩变更入队、前沿节点与四种推荐理由、
 * 根因链、覆盖度各指标、鉴权。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { createApp } from "../../app.ts";
import {
  createUserToken,
  initRedisForTest,
  insertContestProblems,
  jsonRequest,
} from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  backgroundTasks,
  contests,
  domainProblemBindings,
  knowledgeAreas,
  knowledgeEdges,
  knowledgeNodes,
  knowledgePacks,
  problemDifficulty,
  problemKnowledge,
  problems,
  problemVersions,
  submissions,
  userKnowledgeMastery,
  users,
} from "../../shared/db/schema.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { _resetBanCacheForTest } from "../../modules/access/identity/services/security/banCache.ts";
import { signToken as signLiveToken } from "../../modules/access/identity/services/security/jwt.ts";
import {
  addDomainMember,
  createDomain,
  setMemberRole,
} from "../../../tests/helpers/workspace-actors.ts";
import { invalidateKnowledgeGraphCache } from "./graph.ts";
import {
  computeNodeMastery,
  diagnoseNode,
  knowledgeMasteryHandler,
  MASTERY_TASK_TYPE,
  rankFrontierNodes,
  readCoverage,
  readMyMastery,
  readMyRecommendations,
  recomputeRecentlyUnprotectedMastery,
  recomputeUserMastery,
  ROOT_CAUSE_THRESHOLD,
  upperThirdThreshold,
} from "./mastery.ts";
import { pickNextLadderItem } from "./difficulty.ts";
import { type KnowledgeGraphNode } from "./graph.ts";

await resetDbForTest();
await initRedisForTest();
await updateSetting(
  "knowledge_enabled",
  true,
  userActorFromAuthenticatedId("0"),
);
await updateSetting(
  "knowledge_mastery_min_solved",
  3,
  userActorFromAuthenticatedId("0"),
);

const admin = () => userActorFromAuthenticatedId("0");
const NOW = () => new Date().toISOString();

async function tokenFor(sub: string, role: string): Promise<string> {
  const token = await signLiveToken({ sub, role }, {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  _resetBanCacheForTest();
  return token;
}

async function mkUser(): Promise<string> {
  const id = crypto.randomUUID();
  await db().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: NOW(),
    updated_at: NOW(),
  });
  return id;
}

function db() {
  return getDb();
}

/** 内容包 + 领域 + 若干节点与前置边。 */
async function seedGraph(input: {
  areas: Array<{ id: string; sort: number }>;
  nodes: Array<
    { id: string; area: string; name?: string; requires?: string[] }
  >;
}): Promise<void> {
  const d = db();
  const now = NOW();
  if (
    (await d.select({ id: knowledgePacks.id }).from(knowledgePacks)).length ===
      0
  ) {
    await d.insert(knowledgePacks).values({
      id: "official",
      name: "官方",
      version: "test",
      license: "CC",
      active: true,
      imported_at: now,
    });
  }
  for (const area of input.areas) {
    await d.insert(knowledgeAreas).values({
      id: area.id,
      pack_id: "official",
      name: area.id,
      sort: area.sort,
    }).onConflictDoNothing();
  }
  for (const node of input.nodes) {
    await d.insert(knowledgeNodes).values({
      id: node.id,
      area_id: node.area,
      pack_id: "official",
      name: node.name ?? node.id,
      summary: "",
      syllabus: [],
      status: "active",
      doc_path: null,
      updated_at: now,
    }).onConflictDoNothing();
  }
  for (const node of input.nodes) {
    for (const from of node.requires ?? []) {
      await d.insert(knowledgeEdges).values({ from_id: from, to_id: node.id })
        .onConflictDoNothing();
    }
  }
  invalidateKnowledgeGraphCache();
}

/** 题目夹具：发布 + 域绑定 + 主知识点挂载（可指定校准难度）。 */
async function mkProblem(input: {
  domainId: string;
  authorId: string;
  ownerId?: string;
  number: number;
  nodeId: string;
  calibrated?: number;
  is_objective?: boolean;
  published?: boolean;
  review_status?: string;
  deprecatedNodeId?: string;
  passRatioOverride?: number;
}): Promise<{ problemId: string; bindingId: string; versionId: string }> {
  const d = db();
  const now = NOW();
  const problemId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await d.insert(problems).values({
    id: problemId,
    domain_id: input.domainId,
    number: input.number,
    title: `题 ${input.number}`,
    description: "",
    owner_id: input.ownerId ?? input.authorId,
    is_objective: input.is_objective ?? false,
    difficulty: "medium",
    created_at: now,
    updated_at: now,
  });
  await d.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content: {},
    published_at: now,
    published_by: "0",
  } as never);
  if (input.published !== false) {
    await d.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
  }
  const bindingId = crypto.randomUUID();
  await d.insert(domainProblemBindings).values({
    id: bindingId,
    domain_id: input.domainId,
    problem_id: problemId,
    visibility: "members",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  await d.insert(problemKnowledge).values([
    {
      problem_id: problemId,
      node_id: input.nodeId,
      role: "primary",
      source: "human",
      confidence: null,
      version_id: versionId,
      review_status: input.review_status ?? "confirmed",
      updated_at: now,
    },
    ...(input.deprecatedNodeId
      ? [{
        problem_id: problemId,
        node_id: input.deprecatedNodeId,
        role: "secondary" as const,
        source: "human" as const,
        confidence: null,
        version_id: versionId,
        review_status: "confirmed",
        updated_at: now,
      }]
      : []),
  ]);
  if (input.calibrated !== undefined || input.passRatioOverride !== undefined) {
    const score = input.calibrated ?? 50;
    await d.insert(problemDifficulty).values({
      problem_id: problemId,
      prior: score,
      calibrated: score,
      sample_size: 3,
      pass_ratio_override: input.passRatioOverride ?? null,
      updated_at: String(now),
    });
  }
  return { problemId, bindingId, versionId };
}

/** 写一次有效成绩（普通提交）；`accepted` 为是否一次通过（分数 10000）。 */
async function mkScore(input: {
  domainId: string;
  bindingId: string;
  problemId: string;
  userId: string;
  score: number;
  contestId?: string | null;
}): Promise<void> {
  const d = db();
  const now = NOW();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await d.insert(submissions).values({
    id: submissionId,
    domain_id: input.domainId,
    domain_problem_binding_id: input.bindingId,
    user_id: input.userId,
    problem_id: input.problemId,
    contest_id: input.contestId ?? null,
    language: "c",
    code: "",
    created_at: now,
  } as never);
  await d.execute(sql`
    INSERT INTO evaluation_attempts
      (id, submission_id, problem_id, sequence, source, state,
       result_kind, score, accepted, created_at)
    VALUES (${attemptId}, ${submissionId}, ${input.problemId}, 0, 'initial',
            'finished', 'graded', ${input.score}, ${
    input.score >= 10000
  }, ${now})
  `);
  await d.update(submissions).set({ effective_attempt_id: attemptId })
    .where(eq(submissions.id, submissionId));
}

/** 域 + 作者 + 节点夹具（节点放在自有领域下）。 */
async function baseFixture(slug: string) {
  await updateSetting("domain_creation_policy", "open", admin());
  await updateSetting("knowledge_enabled", true, admin());
  await updateSetting("knowledge_mastery_min_solved", 3, admin());
  // 每个用例都从默认及格线开始，避免其他用例改动的设置泄漏（进程内设置缓存跨用例保留）。
  await updateSetting("knowledge_pass_ratio", 60, admin());
  const domain = await createDomain(
    { slug, name: slug, preset: "community" },
    "0",
  );
  const author = await mkUser();
  await addDomainMember(db(), domain.id, author);
  await setMemberRole(domain.slug, "0", author, "educator");
  return { domain, author };
}

Deno.test("knowledge mastery: 掌握规则纯函数（题量 < K、上三分之一、learning）", () => {
  // 题量 < K：全部达标即掌握。
  assertEquals(
    computeNodeMastery({
      total: 2,
      passed_difficulties: [20, 30],
      difficulties: [20, 30],
      solved_count: 2,
      attempted_count: 2,
      failed_attempts: 0,
    }, 3).state,
    "mastered",
  );
  // 题量 < K 但未全部达标 → learning。
  assertEquals(
    computeNodeMastery({
      total: 2,
      passed_difficulties: [20],
      difficulties: [20, 30],
      solved_count: 1,
      attempted_count: 1,
      failed_attempts: 0,
    }, 3).state,
    "learning",
  );
  // 题量 ≥ K：达标题数够但没有上三分之一难度 → learning。
  assertEquals(
    computeNodeMastery({
      total: 6,
      passed_difficulties: [10, 20, 30],
      difficulties: [10, 20, 30, 40, 50, 60],
      solved_count: 3,
      attempted_count: 3,
      failed_attempts: 0,
    }, 3).state,
    "learning",
  );
  // 含一道上三分之一难度 → mastered。
  const masteredResult = computeNodeMastery({
    total: 6,
    passed_difficulties: [10, 20, 50],
    difficulties: [10, 20, 30, 40, 50, 60],
    solved_count: 3,
    attempted_count: 3,
    failed_attempts: 2,
  }, 3);
  assertEquals(masteredResult.state, "mastered");
  assertEquals(masteredResult.solved_count, 3);
  assertEquals(masteredResult.attempted_count, 3);
  assertEquals(masteredResult.failed_attempts, 2);
  assertEquals(masteredResult.max_passed_difficulty, 50);
  assertEquals(masteredResult.evidence_weight, 3);
  assertEquals(masteredResult.ability_score >= 45, true);
  assertEquals(masteredResult.last_passed_at, null);
  // 稀疏题库（1 道简单题）防虚高 → 停留 learning；1 道高难题（d >= 67）→ mastered。
  assertEquals(
    computeNodeMastery({
      total: 1,
      passed_difficulties: [20],
      difficulties: [20],
      solved_count: 1,
      attempted_count: 1,
      failed_attempts: 0,
    }, 3).state,
    "learning",
  );
  assertEquals(
    computeNodeMastery({
      total: 1,
      passed_difficulties: [75],
      difficulties: [75],
      solved_count: 1,
      attempted_count: 1,
      failed_attempts: 0,
    }, 3).state,
    "mastered",
  );
  // 无达标 → none。
  assertEquals(
    computeNodeMastery({
      total: 4,
      passed_difficulties: [],
      difficulties: [10, 20, 30, 40],
      solved_count: 0,
      attempted_count: 2,
      failed_attempts: 2,
    }).state,
    "none",
  );
  // 上三分之一阈值：6 题取第 4 个（index floor(12/3)=4 → 50）。
  assertEquals(upperThirdThreshold([60, 10, 50, 20, 40, 30]), 50);
  assertEquals(upperThirdThreshold([]), Number.POSITIVE_INFINITY);
});

Deno.test({
  name: "knowledge mastery: 重算（练习 / 进行中比赛 / 保护结束 / 客观题满分）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const f = await baseFixture("kg-mastery-a");
    await seedGraph({
      areas: [{ id: "a", sort: 0 }],
      nodes: [{ id: "a.m", area: "a" }, { id: "a.obj", area: "a" }],
    });
    const p1 = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 1,
      nodeId: "a.m",
      calibrated: 10,
      passRatioOverride: 20,
    });
    const p2 = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 2,
      nodeId: "a.m",
      calibrated: 30,
      passRatioOverride: 20,
    });
    const p3 = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 3,
      nodeId: "a.m",
      calibrated: 90,
      passRatioOverride: 20,
    });
    // 未发布题目不计入题量。
    await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 4,
      nodeId: "a.m",
      calibrated: 20,
      published: false,
    });
    const user = await mkUser();
    await addDomainMember(db(), f.domain.id, user);

    // 及格线覆盖按题生效：20% → 3000 分达标（learning 而非 none）。
    const passRaw = await db().execute(
      sql`SELECT pass_ratio_override FROM problem_difficulty
          WHERE problem_id = ${p1.problemId}`,
    );
    assertEquals(
      (passRaw as unknown as { pass_ratio_override: number }[])[0]
        ?.pass_ratio_override,
      20,
    );
    // 一道未达标（learning）。题量与 P2 一致：难度分 10 / 30 / 90，payload 按顺序。
    await mkScore({
      domainId: f.domain.id,
      bindingId: p1.bindingId,
      problemId: p1.problemId,
      userId: user,
      score: 3000,
    });
    let result = await recomputeUserMastery(user);
    assertEquals(result.learning, 1);
    let rows = await db().select().from(
      userKnowledgeMastery,
    ).where(eq(
      userKnowledgeMastery.user_id,
      user,
    ));
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.state, "learning");
    assertEquals(rows[0]!.solved_count, 1);
    assertEquals(rows[0]!.attempted_count, 1);
    assertEquals(rows[0]!.failed_attempts, 1);
    assertEquals(rows[0]!.max_passed_difficulty, 10);

    // 三题全达标（含上三分之一）→ mastered。
    await mkScore({
      domainId: f.domain.id,
      bindingId: p1.bindingId,
      problemId: p1.problemId,
      userId: user,
      score: 10000,
    });
    await mkScore({
      domainId: f.domain.id,
      bindingId: p2.bindingId,
      problemId: p2.problemId,
      userId: user,
      score: 9000,
    });
    await mkScore({
      domainId: f.domain.id,
      bindingId: p3.bindingId,
      problemId: p3.problemId,
      userId: user,
      score: 6500,
    });
    result = await recomputeUserMastery(user);
    assertEquals(result.mastered, 1);
    rows = await db().select().from(
      userKnowledgeMastery,
    );
    assertEquals(rows[0]!.solved_count, 3);
    assertEquals(rows[0]!.max_passed_difficulty, 90);
    assertEquals(rows[0]!.ability_score >= 45, true);
    assertEquals(rows[0]!.evidence_weight, 3);
    assertEquals(typeof rows[0]!.last_passed_at, "string");

    // 读时遗忘衰减：90 天后读取 mastery 触发 needs_review 且 effective_ability 下降，不改 DB。
    const futureNow = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
    const decayedView = await readMyMastery(
      user,
      { id: f.domain.id, slug: f.domain.slug },
      db(),
      futureNow,
    );
    const decayedItem = decayedView.items.find((i) => i.node_id === "a.m")!;
    assertEquals(decayedItem.needs_review, true);
    assertEquals(
      decayedItem.effective_ability < decayedItem.ability_score,
      true,
    );
    const [persistedAfterRead] = await db().select().from(userKnowledgeMastery)
      .where(eq(userKnowledgeMastery.user_id, user));
    assertEquals(persistedAfterRead!.ability_score, decayedItem.ability_score);

    // 推荐唤醒：遗忘节点优先进入推荐，且在全部题已达标时仍返回复习题。
    const reviewRecs = await readMyRecommendations(
      user,
      { id: f.domain.id, slug: f.domain.slug },
      5,
      db(),
      futureNow,
    );
    assertEquals(reviewRecs.items[0]?.node.id, "a.m");
    assertEquals(reviewRecs.items[0]?.reason.code, "needs_review");
    assertEquals(reviewRecs.items[0]?.node.needs_review, true);
    assertEquals(reviewRecs.items[0]?.next !== null, true);

    // 保护期：题目处于进行中保密比赛 → 其成绩不计，节点回到 learning。
    const now = NOW();
    const runningId = crypto.randomUUID();
    await db().insert(contests).values({
      id: runningId,
      public_id: `c-${runningId.slice(0, 8)}`,
      domain_id: f.domain.id,
      title: "保密进行中",
      type: "oi",
      kind: "public",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      owner_id: "0",
      secrecy_enabled: true,
      created_at: now,
      updated_at: now,
    } as never);
    await insertContestProblems([{
      contest_id: runningId,
      problem_id: p3.problemId,
      label: "A",
      score: 100,
      sort_order: 1,
    }]);
    result = await recomputeUserMastery(user);
    // 保护期内 p3 的成绩不计入掌握度（保护结束后的重算见下）。
    assertEquals(result.mastered + result.learning, 1);

    // 保护结束（比赛已结束）→ 周期任务重算计入。
    await db().update(contests).set({
      end_time: new Date(Date.now() - 1000).toISOString(),
    }).where(eq(contests.id, runningId));
    const processed = await recomputeRecentlyUnprotectedMastery();
    assertEquals((processed ?? 0) >= 1, true);
    const [after] = await db().select().from(
      userKnowledgeMastery,
    ).where(eq(
      userKnowledgeMastery.user_id,
      user,
    ));
    // 保护结束后 p3 重新计入（题量与达标数都恢复）→ mastered。
    assertEquals(after!.state, "mastered");
    assertEquals(after!.solved_count, 3);

    // 进行中比赛（非保密）的有效成绩也不计入。
    const user2 = await mkUser();
    const running2 = crypto.randomUUID();
    await db().insert(contests).values({
      id: running2,
      public_id: `c-${running2.slice(0, 8)}`,
      domain_id: f.domain.id,
      title: "进行中",
      type: "oi",
      kind: "public",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      owner_id: "0",
      created_at: now,
      updated_at: now,
    } as never);
    await mkScore({
      domainId: f.domain.id,
      bindingId: p1.bindingId,
      problemId: p1.problemId,
      userId: user2,
      score: 10000,
      contestId: running2,
    });
    const r2 = await recomputeUserMastery(user2);
    // 进行中比赛的成绩完全不计入：不产生任何掌握度记录（连「尝试过」也不写，避免泄露参赛行为）。
    assertEquals(r2.nodes, 0);
    const rows2 = await db().select().from(
      userKnowledgeMastery,
    ).where(eq(
      userKnowledgeMastery.user_id,
      user2,
    ));
    assertEquals(rows2.length, 0);

    // 总开关关闭：不写库。
    await updateSetting("knowledge_enabled", false, admin());
    const off = await recomputeUserMastery(user2);
    assertEquals(off.nodes, 0);
    await updateSetting("knowledge_enabled", true, admin());
  },
});

Deno.test({
  name: "knowledge mastery: 成绩变更入队、增量重算与推荐理由",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const f = await baseFixture("kg-mastery-b");
    await seedGraph({
      areas: [{ id: "b", sort: 0 }, { id: "c", sort: 1 }],
      nodes: [
        { id: "b.entry", area: "b" },
        // expect_mastered：difference
        { id: "b.mid", area: "b", requires: ["b.entry"] },
        // 入门节点：无前置；后继节点 b.next 前置已掌握。
        { id: "b.next", area: "b", requires: ["b.mid"] },
      ],
    });
    const entry = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 1,
      nodeId: "b.entry",
      calibrated: 10,
      passRatioOverride: 20,
    });
    const mid = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 2,
      nodeId: "b.mid",
      // 稀疏节点（1 题）：配置高难题（calibrated >= 67）高分攻克方可 mastered。
      calibrated: 75,
      passRatioOverride: 20,
    });
    const nextP = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 3,
      nodeId: "b.next",
      calibrated: 30,
      passRatioOverride: 20,
    });
    const user = await mkUser();
    await addDomainMember(db(), f.domain.id, user);

    // 有效成绩变更（无提交事务，直接写提交 + 调用入队 helper）→ 任务入队。
    const { enqueueKnowledgeMasteryTaskTx } = await import(
      "../../modules/evaluations/index.ts"
    );
    await db().transaction(async (tx) => {
      await enqueueKnowledgeMasteryTaskTx(tx, {
        userId: user,
        problemId: mid.problemId,
      });
      await enqueueKnowledgeMasteryTaskTx(tx, {
        userId: user,
        problemId: mid.problemId,
      });
    });
    const tasks = await db().select().from(backgroundTasks).where(
      and(
        eq(backgroundTasks.task_type, MASTERY_TASK_TYPE),
        eq(backgroundTasks.target_id, user),
      ),
    );
    assertEquals(tasks.length, 1, "同题重复投递按去重键合并");

    // 任务 handler：整体重算。
    await mkScore({
      domainId: f.domain.id,
      bindingId: mid.bindingId,
      problemId: mid.problemId,
      userId: user,
      score: 10000,
    });
    const outcome = await knowledgeMasteryHandler({
      id: tasks[0]!.id,
      taskType: MASTERY_TASK_TYPE,
      targetKind: "user_knowledge_mastery",
      targetId: user,
      dedupeKey: `mastery:${mid.problemId}`,
      payloadVersion: 1,
      payload: { user_id: user },
      failureCount: 0,
      leaseToken: "t",
      leaseExpiry: NOW(),
    }, new AbortController().signal) as Record<string, unknown>;
    assertEquals(outcome.status, "recomputed");
    assertEquals(outcome.mastered, 1);

    // 推荐：前置未掌握 → 只有入门节点（entry_point）；mid 不出现。
    const graph = await (await import("./graph.ts")).readKnowledgeGraph();
    const nodes: KnowledgeGraphNode[] = graph.nodes;
    const states = new Map<string, "none" | "learning" | "mastered">([
      ["b.mid", "learning"],
    ]);
    const counts = new Map<string, number>([
      ["b.entry", 1],
      ["b.mid", 1],
      ["b.next", 1],
    ]);
    const failed = new Map<string, number>();
    const rank = (
      failedOf: (id: string) => number,
    ) =>
      rankFrontierNodes(nodes, (node) => ({
        area_sort: graph.areas.find((area) => area.id === node.area)?.sort ?? 0,
        node_sort: nodes.indexOf(node),
      }), {
        stateOf: (id) => states.get(id) ?? "none",
        failedOf,
        countOf: (id) => counts.get(id) ?? 0,
        solvedOf: () => 1,
      });
    let ranked = rank((id) => failed.get(id) ?? 0);
    assertEquals(ranked.length, 1);
    assertEquals(ranked[0]!.node.id, "b.entry");
    assertEquals(ranked[0]!.reason.code, "entry_point");

    // 前置已掌握：entry 掌握后 mid 变为 continue_learning，next 为 prerequisites_mastered。
    states.set("b.entry", "mastered");
    ranked = rank((id) => failed.get(id) ?? 0);
    assertEquals(ranked.map((item) => item.node.id), ["b.mid"]);
    assertEquals(ranked[0]!.reason.code, "continue_learning");
    assertEquals(ranked[0]!.reason.params.remaining, 2);
    // 前沿仅限「所有前置均已掌握」：b.next 的前置 b.mid 仍在学习中，不推荐。
    assertEquals(
      ranked.some((item) => item.node.id === "b.next"),
      false,
    );

    // 根因提示：entry 未掌握、mid 未达标 ≥ 3 次 → review_prerequisite（指向 entry）。
    states.set("b.entry", "none");
    failed.set("b.mid", ROOT_CAUSE_THRESHOLD);
    ranked = rank((id) => failed.get(id) ?? 0);
    assertEquals(ranked[0]!.node.id, "b.entry");
    assertEquals(ranked[0]!.reason.code, "review_prerequisite");
    assertEquals(ranked[0]!.reason.params.node_id, "b.mid");
    assertEquals(ranked[0]!.reason.params.prerequisite_id, "b.entry");

    // 根因提示边界修复：state === 'none'（零通过）但未达标 ≥ 3 次同样触发 review_prerequisite。
    states.set("b.mid", "none");
    failed.set("b.mid", ROOT_CAUSE_THRESHOLD);
    ranked = rank((id) => failed.get(id) ?? 0);
    assertEquals(ranked[0]!.node.id, "b.entry");
    assertEquals(ranked[0]!.reason.code, "review_prerequisite");
    assertEquals(ranked[0]!.reason.params.node_id, "b.mid");
    states.set("b.mid", "learning");

    // 遗忘复习唤醒：已掌握节点 needsReviewOf=true 时进入推荐（优先级高于入门新节点）。
    states.set("b.entry", "mastered");
    const reviewRanked = rankFrontierNodes(nodes, (node) => ({
      area_sort: graph.areas.find((area) => area.id === node.area)?.sort ?? 0,
      node_sort: nodes.indexOf(node),
    }), {
      stateOf: (id) => id === "b.entry" ? "mastered" : "none",
      failedOf: () => 0,
      countOf: (id) => counts.get(id) ?? 0,
      solvedOf: () => 0,
      needsReviewOf: (id) => id === "b.entry",
      abilityOf: () => 78,
      effectiveAbilityOf: () => 62,
    });
    assertEquals(reviewRanked[0]!.node.id, "b.entry");
    assertEquals(reviewRanked[0]!.reason.code, "needs_review");

    // 下一题目标难度匹配：pickNextLadderItem 按 targetDifficulty（如 ability + 5）择优。
    const picked = pickNextLadderItem([
      {
        problem_id: "p-easy",
        number: 1,
        title: "易",
        domain: "d",
        difficulty: 20,
        tier: "easy",
        sample_size: 10,
        passed: false,
      },
      {
        problem_id: "p-fit",
        number: 2,
        title: "适中",
        domain: "d",
        difficulty: 55,
        tier: "medium",
        sample_size: 10,
        passed: false,
      },
      {
        problem_id: "p-hard",
        number: 3,
        title: "难",
        domain: "d",
        difficulty: 90,
        tier: "hard",
        sample_size: 10,
        passed: false,
      },
    ], { targetDifficulty: 50 + 5 });
    assertEquals(picked?.problem_id, "p-fit");

    // 未达标不足 3 次 → 不出根因提示，只有入门节点。
    states.set("b.entry", "none");
    failed.set("b.mid", ROOT_CAUSE_THRESHOLD - 1);
    ranked = rank((id) => failed.get(id) ?? 0);
    assertEquals(ranked.map((item) => item.reason.code), ["entry_point"]);

    // 题量不足的节点不进推荐。
    counts.set("b.entry", 0);
    ranked = rank(() => 0);
    assertEquals(ranked.length, 0);

    // 根因链：b.next ← b.mid ← b.entry。夹具中该用户已达标 b.mid 唯一一题（题量 < K 时全部
    // 达标即掌握），故 b.mid 已掌握、不进链；链上只剩未掌握的 b.entry（第 2 层），直接前置均已掌握。
    const diagnosis = await diagnoseNode(user, "b.next");
    assertEquals(
      diagnosis?.missing_prerequisites.map((item) => item.node_id),
      [],
    );
    assertEquals(diagnosis?.chain.map((item) => [item.node_id, item.depth]), [
      ["b.entry", 2],
    ]);
    assertEquals(await diagnoseNode(user, "b.nope"), null);

    // 题目存在性：确保夹具题目已挂载（供覆盖度用例复用断言）。
    assertEquals(typeof nextP.problemId, "string");
    assertEquals(typeof entry.problemId, "string");
  },
});

Deno.test({
  name:
    "knowledge mastery: 覆盖度指标（题量不足、难度断层、未归类、待确认、失效挂载）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const f = await baseFixture("kg-mastery-c");
    const now = NOW();
    await seedGraph({
      areas: [{ id: "d", sort: 0 }],
      nodes: [
        { id: "d.small", area: "d" },
        { id: "d.full", area: "d" },
      ],
    });
    // 已废弃节点（失效挂载）。
    await db().insert(knowledgeNodes).values({
      id: "d.old",
      area_id: "d",
      pack_id: "official",
      name: "旧节点",
      summary: "",
      syllabus: [],
      status: "deprecated",
      doc_path: null,
      updated_at: now,
    });
    // d.small 共 3 题（第 7 题带失效挂载），K=3 时不构成题量不足。
    await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 10,
      nodeId: "d.small",
      calibrated: 40,
    });
    await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 2,
      nodeId: "d.small",
      calibrated: 20,
    });
    // 四题但只有 easy/medium → 难度断层（上三分之一为第四题，难度 40）。
    // 保留一个无难度行的题（先验 medium）作为第四题。
    await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 9,
      nodeId: "d.full",
    });
    for (const [number, score] of [[3, 10], [4, 20], [5, 30]] as const) {
      await mkProblem({
        domainId: f.domain.id,
        authorId: f.author,
        number,
        nodeId: "d.full",
        calibrated: score,
      });
    }
    // 待确认挂载（pending）+ 失效挂载（deprecated 节点）。
    const pending = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 6,
      nodeId: "d.full",
      review_status: "pending",
    });
    await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 7,
      nodeId: "d.small",
      deprecatedNodeId: "d.old",
    });
    // 未归类题目。
    const unclassified = crypto.randomUUID();
    const version = crypto.randomUUID();
    await db().insert(problems).values({
      id: unclassified,
      domain_id: f.domain.id,
      number: 8,
      title: "未归类",
      description: "",
      owner_id: f.author,
      difficulty: "easy",
      created_at: now,
      updated_at: now,
    });
    await db().insert(problemVersions).values({
      id: version,
      problem_id: unclassified,
      version: 1,
      content: {},
      published_at: now,
      published_by: "0",
    } as never);
    await db().update(problems).set({ latest_version_id: version }).where(
      eq(problems.id, unclassified),
    );
    await db().insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: f.domain.id,
      problem_id: unclassified,
      visibility: "members",
      created_by: "0",
      created_at: now,
      updated_at: now,
    });

    const view = await readCoverage({ id: f.domain.id, slug: f.domain.slug });
    assertEquals(view.min_solved, 3);
    const small = view.nodes.find((node) => node.node_id === "d.small")!;
    assertEquals(small.problem_count, 3);
    assertEquals(small.insufficient_problems, false);
    const full = view.nodes.find((node) => node.node_id === "d.full")!;
    // pending 挂载计入题量（4 + 1），但不进难度分布。
    assertEquals(full.problem_count, 5);
    assertEquals(full.insufficient_problems, false);
    // 校准 10/20/30 为 easy，第四题无校准行按出题人 medium 先验（50）。
    assertEquals(full.difficulty_distribution, {
      easy: 3,
      medium: 1,
      hard: 0,
    });
    assertEquals(full.difficulty_gap, true);
    // d.small 同样没有困难档题目（40/20 及无校准行的题）→ 也是难度断层。
    assertEquals(small.difficulty_gap, true);
    assertEquals(view.totals.nodes_with_problems, 2);
    assertEquals(view.totals.difficulty_gap, 2);
    assertEquals(view.unclassified_problems, 1);
    assertEquals(view.pending_mappings, 1);
    assertEquals(view.deprecated_mappings, 1);
    assertEquals(pending.problemId.length > 0, true);

    // 调小 K：题量不足消失。
    await updateSetting("knowledge_mastery_min_solved", 1, admin());
    const view2 = await readCoverage({ id: f.domain.id, slug: f.domain.slug });
    assertEquals(view2.min_solved, 1);
    assertEquals(view2.totals.insufficient_problems, 0);
  },
});

Deno.test({
  name: "knowledge mastery: API（掌握度 / 推荐 / 诊断 / 覆盖度鉴权）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const f = await baseFixture("kg-mastery-d");
    await seedGraph({
      areas: [{ id: "e", sort: 0 }],
      nodes: [{ id: "e.n", area: "e" }],
    });
    const p1 = await mkProblem({
      domainId: f.domain.id,
      authorId: f.author,
      number: 1,
      nodeId: "e.n",
      // 稀疏单题节点需攻克高难题（d >= 67）才判定 mastered。
      calibrated: 75,
    });
    const app = createApp();
    const userToken = await createUserToken("user");
    const adminToken = await createUserToken("admin");
    const memberToken = await tokenFor(f.author, "user");

    // 未登录：掌握度 / 推荐要求登录；诊断返回空链。
    assertEquals(
      (await jsonRequest(app, "/api/v1/knowledge/me/mastery")).status,
      401,
    );
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/knowledge/me/recommendations?domain=${f.domain.slug}`,
      )).status,
      401,
    );
    const anonDiag = await jsonRequest(
      app,
      "/api/v1/knowledge/nodes/e.n/diagnosis",
    );
    assertEquals(anonDiag.status, 200);
    assertEquals((await anonDiag.json()).data.chain, []);

    // 普通用户：掌握度可读（空），覆盖度 403。
    const masteryRes = await jsonRequest(
      app,
      `/api/v1/knowledge/me/mastery?domain=${f.domain.slug}`,
      { token: memberToken },
    );
    assertEquals(masteryRes.status, 200);
    const masteryData = (await masteryRes.json()).data;
    assertEquals(masteryData.items.length, 1);
    assertEquals(masteryData.items[0].state, "none");
    assertEquals(masteryData.total, 1);
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/admin/knowledge/coverage?domain=${f.domain.slug}`,
        { token: userToken },
      )).status,
      403,
    );

    // 域管理员（educator + problem:write_any）：可看本域覆盖度。
    const authorToken = await tokenFor(f.author, "user");
    const domainCoverage = await jsonRequest(
      app,
      `/api/v1/admin/knowledge/coverage?domain=${f.domain.slug}`,
      { token: authorToken },
    );
    assertEquals(domainCoverage.status, 200);
    assertEquals((await domainCoverage.json()).data.nodes.length, 1);

    // 实例管理员：全实例覆盖度。
    const fullCoverage = await jsonRequest(
      app,
      "/api/v1/admin/knowledge/coverage",
      { token: adminToken },
    );
    assertEquals(fullCoverage.status, 200);
    assertEquals((await fullCoverage.json()).data.domain, null);

    // 用户有成绩后：掌握度与推荐带下一题。
    await mkScore({
      domainId: f.domain.id,
      bindingId: p1.bindingId,
      problemId: p1.problemId,
      userId: f.author,
      score: 4000,
    });
    await recomputeUserMastery(f.author);
    _resetBanCacheForTest();
    const recRes = await jsonRequest(
      app,
      `/api/v1/knowledge/me/recommendations?domain=${f.domain.slug}&limit=5`,
      { token: authorToken },
    );
    assertEquals(recRes.status, 200);
    const recData = (await recRes.json()).data;
    assertEquals(recData.items.length, 1);
    assertEquals(recData.items[0].node.id, "e.n");
    assertEquals(recData.items[0].reason.code, "entry_point");
    assertEquals(recData.items[0].next?.problem_id, p1.problemId);
    // 4000 分（40%）低于默认及格线 60%，尚未达标；再补一次满分提交使其达标。
    await mkScore({
      domainId: f.domain.id,
      bindingId: p1.bindingId,
      problemId: p1.problemId,
      userId: f.author,
      score: 10000,
    });
    await recomputeUserMastery(f.author);
    const myMastery = (await (await jsonRequest(
      app,
      `/api/v1/knowledge/me/mastery?domain=${f.domain.slug}`,
      { token: authorToken },
    )).json()).data;
    // 题量 < K（1 道高难题）高分达标 → mastered，且返回能力分与读时衰减字段。
    assertEquals(myMastery.mastered, 1);
    assertEquals(myMastery.items[0].ability_score >= 50, true);
    assertEquals(
      myMastery.items[0].effective_ability,
      myMastery.items[0].ability_score,
    );
    assertEquals(myMastery.items[0].needs_review, false);
    assertEquals(typeof myMastery.items[0].last_passed_at, "string");
    const diag = await jsonRequest(
      app,
      "/api/v1/knowledge/nodes/e.n/diagnosis",
      { token: authorToken },
    );
    assertEquals(diag.status, 200);
    assertEquals((await diag.json()).data.state, "mastered");
    // 推荐缺少 domain → 400；未知域 → 404。
    assertEquals(
      (await jsonRequest(app, "/api/v1/knowledge/me/recommendations", {
        token: authorToken,
      })).status,
      400,
    );
    assertEquals(
      (await jsonRequest(
        app,
        "/api/v1/knowledge/me/mastery?domain=no-such",
        { token: authorToken },
      )).status,
      404,
    );
    // 总开关关闭 → 404 KNOWLEDGE_DISABLED。
    await updateSetting("knowledge_enabled", false, admin());
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/knowledge/me/mastery?domain=${f.domain.slug}`,
        { token: authorToken },
      )).status,
      404,
    );
    await updateSetting("knowledge_enabled", true, admin());
  },
});
