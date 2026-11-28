/**
 * 摸底诊断（`diagnostic.ts`）与错因补强联动（`remediation.ts`）测试。
 *
 * 覆盖：
 * 1. 下游影响度计算与高杠杆检查点挑选（纯函数）；
 * 2. 错因/薄弱指标关键字到图谱节点的映射与参数解析（纯函数）；
 * 3. `saveSelfAssessedPlacements`（merge / replace / 非法节点报错）与
 *    `readMyRecommendations` 解锁下游前沿但不污染 `user_knowledge_mastery`；
 * 4. `readProblemRemediation` + HTTP 路由、未登录 401 与保护期题目 404 防线。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../app.ts";
import { initRedisForTest, jsonRequest } from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import {
  addDomainMember,
  createDomain,
  setMemberRole,
} from "../../../tests/helpers/workspace-actors.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { _resetBanCacheForTest } from "../../modules/access/identity/services/security/banCache.ts";
import { signToken as signLiveToken } from "../../modules/access/identity/services/security/jwt.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  problems,
  problemVersions,
  userKnowledgeMastery,
  users,
} from "../../shared/db/schema.ts";
import { invalidateKnowledgeGraphCache, readKnowledgeGraph } from "./graph.ts";
import { importPack } from "./import.ts";
import { setProblemKnowledgeManually } from "./mappings.ts";
import {
  rankFrontierNodes,
  readMyMastery,
  readMyRecommendations,
} from "./mastery.ts";
import { resolveOfficialPackDir } from "./pack.ts";
import {
  collectPrerequisiteIds,
  computeDownstreamReach,
  readDiagnosticPlan,
  saveSelfAssessedPlacements,
  selectDiagnosticCheckpoints,
} from "./diagnostic.ts";
import {
  matchSignalsToNodes,
  parseFeedbackSignalParam,
  readProblemRemediation,
} from "./remediation.ts";

await initRedisForTest();

const META = { ipAddress: "127.0.0.1" };
const root = () => userActorFromAuthenticatedId("0");
const user = (id: string) => userActorFromAuthenticatedId(id);

async function tokenFor(sub: string, role = "member"): Promise<string> {
  const token = await signLiveToken(
    { sub, role },
    { expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  );
  _resetBanCacheForTest();
  return token;
}

async function account(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `u_${id.slice(0, 8)}`,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test("diagnostic pure: computeDownstreamReach 与 selectDiagnosticCheckpoints 挑选跨领域高杠杆点", () => {
  const graph = {
    areas: [
      { id: "a", name: "基础", sort: 0 },
      { id: "b", name: "进阶", sort: 1 },
    ],
    nodes: [
      {
        id: "a.root",
        area: "a",
        name: "根基",
        summary: "根",
        syllabus: ["ioai"],
        requires: [],
        doc: "docs/a.md",
      },
      {
        id: "a.leaf",
        area: "a",
        name: "末端",
        summary: "叶",
        syllabus: ["ioai"],
        requires: ["a.root"],
        doc: null,
      },
      {
        id: "b.bridge",
        area: "b",
        name: "桥梁",
        summary: "桥",
        syllabus: ["ioai"],
        requires: ["a.root"],
        doc: null,
      },
      {
        id: "b.top",
        area: "b",
        name: "应用",
        summary: "顶",
        syllabus: ["ioai"],
        requires: ["b.bridge"],
        doc: null,
      },
    ],
  };

  const reach = computeDownstreamReach(graph);
  assertEquals(reach.get("a.root"), 3);
  assertEquals(reach.get("b.bridge"), 1);
  assertEquals(reach.get("a.leaf"), 0);

  const picked = selectDiagnosticCheckpoints(graph, {
    stateOf: (id) => (id === "a.leaf" ? "mastered" : "none"),
    isPlaced: () => false,
    countOf: (id) => (id === "a.root" ? 2 : 0),
    limit: 2,
  });
  assertEquals(picked.length, 2);
  // 第一轮每领域优先选 1 个核心点：a.root 和 b.bridge
  assertEquals(picked.map((p) => p.node.id), ["a.root", "b.bridge"]);
});

Deno.test("remediation pure: parseFeedbackSignalParam 与 matchSignalsToNodes", () => {
  assertEquals(
    parseFeedbackSignalParam(" format_error , Format_Error, hallucination , "),
    ["format_error", "hallucination"],
  );

  const matched = matchSignalsToNodes(["json_parse_error", "RAG检索漏召"], {
    nodes: [
      {
        id: "llm-infer.structured-output",
        area: "llm-infer",
        name: "结构化输出",
        summary: "JSON",
        syllabus: ["lmcc"],
        requires: [],
        doc: "docs/llm-infer.structured-output.md",
      },
      {
        id: "llm-app.rag",
        area: "llm-app",
        name: "RAG",
        summary: "RAG",
        syllabus: ["lmcc"],
        requires: [],
        doc: "docs/llm-app.rag.md",
      },
      {
        id: "math.calculus",
        area: "math",
        name: "微积分",
        summary: "导数",
        syllabus: ["ioai"],
        requires: [],
        doc: null,
      },
    ],
  });
  const ids = matched.map((m) => m.node.id);
  assertEquals(ids.includes("llm-infer.structured-output"), true);
  assertEquals(ids.includes("llm-app.rag"), true);
  assertEquals(ids.includes("math.calculus"), false);
});

Deno.test("rankFrontierNodes: placedOf 放行下游前置并跳过非 learning 已自评点", () => {
  const nodes = [
    {
      id: "prog.python-basics",
      area: "prog",
      name: "Python",
      summary: "",
      syllabus: ["ioai"],
      requires: [],
      doc: null,
    },
    {
      id: "prog.numpy",
      area: "prog",
      name: "NumPy",
      summary: "",
      syllabus: ["ioai"],
      requires: ["prog.python-basics"],
      doc: null,
    },
  ];
  const ranked = rankFrontierNodes(
    nodes,
    (_n) => ({ area_sort: 0, node_sort: 0 }),
    {
      stateOf: () => "none",
      failedOf: () => 0,
      countOf: () => 2,
      solvedOf: () => 0,
      placedOf: (id) => id === "prog.python-basics",
    },
  );
  assertEquals(ranked.map((r) => r.node.id), ["prog.numpy"]);
  assertEquals(ranked[0].reason.code, "prerequisites_mastered");
});

Deno.test({
  name:
    "knowledge v2 integration: 摸底自评、解锁推荐、错因联动、保密防线与 HTTP API",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    invalidateKnowledgeGraphCache();
    await updateSetting("knowledge_enabled", true, root());
    await updateSetting("domain_creation_policy", "open", root());
    await importPack(resolveOfficialPackDir());

    const owner = await account();
    const author = await account();
    const student = await account();
    const domain = await createDomain({
      slug: "kg-v2-school",
      name: "V2 教学域",
      preset: "education",
    }, owner);
    await addDomainMember(getDb(), domain.id, author);
    await addDomainMember(getDb(), domain.id, student);
    await setMemberRole(domain.slug, owner, author, "educator");

    const now = new Date().toISOString();
    const openProblemId = crypto.randomUUID();
    const openVerId = crypto.randomUUID();
    const secretProblemId = crypto.randomUUID();
    const secretVerId = crypto.randomUUID();

    const bindings = new Map<string, string>();
    for (
      const [idx, pid, vid, title] of [
        [1, openProblemId, openVerId, "开放题：NumPy 广播"],
        [2, secretProblemId, secretVerId, "保密赛题"],
      ] as const
    ) {
      await getDb().insert(problems).values({
        id: pid,
        domain_id: domain.id,
        number: idx,
        title,
        description: "desc",
        owner_id: author,
        created_at: now,
        updated_at: now,
      });
      await getDb().insert(problemVersions).values({
        id: vid,
        problem_id: pid,
        version: 1,
        content: {
          kind: "ai",
          title,
          description: "desc",
          samples: [],
          submission_mode: "code",
          template_content: "",
          runtime_config: null,
          artifact_max_size_mb: null,
          llm_config: null,
        },
        published_at: now,
      });
      await getDb().update(problems).set({ latest_version_id: vid }).where(
        eq(problems.id, pid),
      );
      const bindingId = crypto.randomUUID();
      bindings.set(pid, bindingId);
      await getDb().insert(domainProblemBindings).values({
        id: bindingId,
        domain_id: domain.id,
        problem_id: pid,
        visibility: "members",
        created_by: author,
        created_at: now,
        updated_at: now,
      });
    }

    // 把第 2 题放进进行中的正式比赛形成保护期
    const contestId = crypto.randomUUID();
    await getDb().insert(contests).values({
      id: contestId,
      domain_id: domain.id,
      title: "进行中比赛",
      type: "acm",
      secrecy_enabled: true,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      created_by: author,
      created_at: now,
      updated_at: now,
    });
    await getDb().insert(contestProblems).values({
      domain_id: domain.id,
      domain_problem_binding_id: bindings.get(secretProblemId)!,
      contest_id: contestId,
      problem_id: secretProblemId,
      sort_order: 0,
      label: "A",
      score: 100,
      pinned_version_id: secretVerId,
    });

    await setProblemKnowledgeManually(user(author), openProblemId, {
      primary: "prog.numpy",
      secondary: ["prog.pandas"],
    }, META);
    await setProblemKnowledgeManually(user(author), secretProblemId, {
      primary: "llm.tokenizers",
      secondary: [],
    }, META);

    // 1. 未知节点自评校验报错
    await assertRejects(
      () =>
        saveSelfAssessedPlacements(student, {
          node_ids: ["not.exist.node"],
        }),
      Error,
      "未知",
    );

    // 2. 自评基础语法与数据结构 → 解锁下游推荐，且不写入虚假做题掌握度
    const saved = await saveSelfAssessedPlacements(student, {
      node_ids: ["prog.python-basics", "prog.python-data-structures"],
    });
    assertEquals(saved.added_count, 2);
    assertEquals(saved.total_placed, 2);

    const mastery = await readMyMastery(student, domain);
    assertEquals(mastery.placed_nodes, [
      "prog.python-basics",
      "prog.python-data-structures",
    ]);
    assertEquals(mastery.mastered, 0);
    const dbMasteryRows = await getDb().select().from(userKnowledgeMastery)
      .where(eq(userKnowledgeMastery.user_id, student));
    assertEquals(dbMasteryRows.length, 0);

    const recs = await readMyRecommendations(student, domain, 5);
    assertEquals(recs.items.some((i) => i.node.id === "prog.numpy"), true);

    // 3. replace 模式可回退/替换自评集合
    const replaced = await saveSelfAssessedPlacements(student, {
      node_ids: ["prog.python-basics"],
      mode: "replace",
    });
    assertEquals(replaced.placed_nodes, ["prog.python-basics"]);
    assertEquals(replaced.removed_count, 1);

    // 3b. 一键标熟（含前置级联）与取消标熟（mode = 'remove'）
    const graphForPrereq = await readKnowledgeGraph();
    const expectedPrereqs = collectPrerequisiteIds(graphForPrereq, [
      "prog.numpy",
    ]);
    assertEquals(expectedPrereqs.has("prog.python-basics"), true);
    const cascaded = await saveSelfAssessedPlacements(student, {
      node_ids: ["prog.numpy"],
      mode: "merge",
      include_prerequisites: true,
    });
    assertEquals(cascaded.placed_nodes.includes("prog.numpy"), true);
    for (const reqId of expectedPrereqs) {
      assertEquals(cascaded.placed_nodes.includes(reqId), true);
    }
    const unmarked = await saveSelfAssessedPlacements(student, {
      node_ids: ["prog.numpy"],
      mode: "remove",
    });
    assertEquals(unmarked.placed_nodes.includes("prog.numpy"), false);
    assertEquals(unmarked.removed_count, 1);
    assertEquals(
      (await getDb().select().from(userKnowledgeMastery).where(
        eq(userKnowledgeMastery.user_id, student),
      )).length,
      0,
    );
    // 恢复为仅 prog.python-basics 供后续断言使用
    await saveSelfAssessedPlacements(student, {
      node_ids: ["prog.python-basics"],
      mode: "replace",
    });

    // 4. 摸底计划与官方图谱一致，含 14 领域与检查点
    const graph = await readKnowledgeGraph();
    const plan = await readDiagnosticPlan(student, domain);
    assertEquals(plan.areas.length, graph.areas.length);
    assertEquals(plan.checkpoints.length, 8);
    assertEquals(plan.placed_nodes, ["prog.python-basics"]);

    // 5. 错因联动服务与保护期 404
    const rem = await readProblemRemediation(openProblemId, {
      userId: student,
    }, {
      errorTypes: ["json_format_error"],
      weakMetrics: ["shape_accuracy"],
    });
    assertEquals(
      rem?.items.some((i) => i.node_id === "prog.numpy"),
      true,
    );
    assertEquals(
      rem?.items.some((i) => i.node_id === "llm-infer.structured-output"),
      true,
    );
    assertEquals(
      rem?.items.some((i) => i.node_id === "prog.python-data-structures"),
      true,
    );
    assertEquals(
      await readProblemRemediation(secretProblemId, { userId: student }),
      null,
    );

    // 6. HTTP 路由验证
    const app = createApp();
    const unauth = await jsonRequest(app, "/api/v1/knowledge/me/diagnostic");
    assertEquals(unauth.status, 401);

    const token = await tokenFor(student);
    const diagRes = await jsonRequest(
      app,
      `/api/v1/knowledge/me/diagnostic?domain=${domain.slug}`,
      { token },
    );
    assertEquals(diagRes.status, 200);
    const diagJson = (await diagRes.json()).data;
    assertEquals(diagJson.checkpoints.length, 8);

    const postRes = await jsonRequest(
      app,
      "/api/v1/knowledge/me/diagnostic/self-assess",
      {
        method: "POST",
        token,
        body: { area_ids: ["math"], mode: "merge" },
      },
    );
    assertEquals(postRes.status, 200);
    assertEquals((await postRes.json()).data.total_placed > 1, true);

    const remRes = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${openProblemId}/remediation?domain=${domain.slug}&error_types=json_format_error`,
      { token },
    );
    assertEquals(remRes.status, 200);
    assertEquals(
      ((await remRes.json()).data.items as Array<{ node_id: string }>).some(
        (i) => i.node_id === "llm-infer.structured-output",
      ),
      true,
    );

    const secretRemRes = await jsonRequest(
      app,
      `/api/v1/knowledge/problems/${secretProblemId}/remediation?domain=${domain.slug}`,
      { token },
    );
    assertEquals(secretRemRes.status, 404);
  },
});
