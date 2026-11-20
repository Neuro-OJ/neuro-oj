/**
 * 题目—知识点挂载服务测试（真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 覆盖：人工挂载权限（出题人可 / 普通成员 403 / 实例管理员可）、输入校验、
 * 整体替换、AI 不覆盖人工、阈值 → auto/pending、审核 accept/reject/修改、
 * rejected 后回到未归类、节点废弃后读取过滤、比赛保护期间隐藏。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  knowledgeAreas,
  knowledgeNodes,
  knowledgePacks,
  problemKnowledge,
  problems,
  problemVersions,
  users,
} from "../../shared/db/schema.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import {
  addDomainMember,
  createDomain,
  setMemberRole,
} from "../../modules/access/workspace/index.ts";
import { NotFoundError } from "../../shared/base/errors.ts";
import { initRedisForTest } from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import {
  applyAiMapping,
  listPendingMappings,
  readProblemKnowledge,
  reviewMapping,
  setProblemKnowledgeManually,
} from "./mappings.ts";

await initRedisForTest();

const META = { ipAddress: "127.0.0.1" };
const root = () => userActorFromAuthenticatedId("0");
const user = (id: string) => userActorFromAuthenticatedId(id);

async function account(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 测试夹具：一个域、出题人（education 预设的 educator）、普通成员、一道题。 */
async function fixture() {
  await resetDbForTest();
  await updateSetting("domain_creation_policy", "open", root());
  const owner = await account();
  const author = await account();
  const member = await account();
  const school = await createDomain({
    slug: "kg-school",
    name: "知识图谱学校",
    preset: "education",
  }, owner);
  await addDomainMember(getDb(), school.id, author);
  await addDomainMember(getDb(), school.id, member);
  await setMemberRole(school.slug, owner, author, "educator");
  const now = new Date().toISOString();
  const problemId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await getDb().insert(problems).values({
    id: problemId,
    domain_id: school.id,
    number: 1,
    title: "知识图谱题",
    description: "题面",
    owner_id: author,
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content: {
      kind: "ai",
      title: "知识图谱题",
      description: "题面",
      samples: [],
      submission_mode: "code",
      template_content: "print(1)",
      runtime_config: null,
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await getDb().insert(knowledgePacks).values({
    id: "test",
    name: "测试包",
    version: "1",
    license: "CC",
    active: true,
    imported_at: now,
  });
  await getDb().insert(knowledgeAreas).values({
    id: "area",
    pack_id: "test",
    name: "领域",
    sort: 0,
  });
  await getDb().insert(knowledgeNodes).values(
    ["n.a", "n.b", "n.c", "n.d", "n.e", "n.old"].map((id, i) => ({
      id,
      area_id: "area",
      pack_id: "test",
      name: `节点 ${id}`,
      summary: "",
      status: id === "n.old" ? "deprecated" : "active",
      sort: i,
      updated_at: now,
    })),
  );
  return { owner, author, member, school, problemId, versionId };
}

Deno.test({
  name:
    "knowledge mappings: 人工挂载权限（出题人可，普通成员 403，实例管理员可）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    const view = await setProblemKnowledgeManually(
      user(f.author),
      f.problemId,
      { primary: "n.a", secondary: ["n.b"] },
      META,
    );
    assertEquals(view.state, "classified");
    assertEquals(view.primary?.node_id, "n.a");
    assertEquals(view.primary?.source, "human");
    assertEquals(view.primary?.review_status, "confirmed");
    assertEquals(view.primary?.confidence, null);
    assertEquals(view.secondary.map((item) => item.node_id), ["n.b"]);

    await assertRejects(
      () =>
        setProblemKnowledgeManually(user(f.member), f.problemId, {
          primary: "n.c",
          secondary: [],
        }, META),
      Error,
      "无权",
    );
    // 普通成员按查看者读取：保护之外可读。
    assertEquals(
      (await readProblemKnowledge(f.problemId, { userId: f.member }))?.primary
        ?.node_id,
      "n.a",
    );
    // 实例管理员（平台治理）可改。
    const admin = await setProblemKnowledgeManually(root(), f.problemId, {
      primary: "n.c",
      secondary: [],
    }, META);
    assertEquals(admin.primary?.node_id, "n.c");
  },
});

Deno.test({
  name: "knowledge mappings: 校验（节点不存在/废弃、超限、含 primary）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    const cases: unknown[] = [
      { primary: "no.such", secondary: [] },
      { primary: "n.old", secondary: [] },
      { primary: "n.a", secondary: ["n.b", "n.c", "n.d", "n.e"] },
      { primary: "n.a", secondary: ["n.a"] },
      { primary: "", secondary: [] },
      { primary: "n.a", secondary: "n.b" },
    ];
    for (const body of cases) {
      await assertRejects(
        () =>
          setProblemKnowledgeManually(user(f.author), f.problemId, body, META),
        Error,
      );
    }
    // 失败不落库。
    assertEquals(
      (await readProblemKnowledge(f.problemId, { userId: null }))?.state,
      "unclassified",
    );
  },
});

Deno.test({
  name: "knowledge mappings: 人工挂载整体替换；节点废弃后读取过滤",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setProblemKnowledgeManually(user(f.author), f.problemId, {
      primary: "n.a",
      secondary: ["n.b", "n.c"],
    }, META);
    const replaced = await setProblemKnowledgeManually(
      user(f.author),
      f.problemId,
      { primary: "n.d", secondary: [] },
      META,
    );
    assertEquals(replaced.primary?.node_id, "n.d");
    assertEquals(replaced.secondary, []);
    const rows = await getDb().select().from(problemKnowledge).where(
      eq(problemKnowledge.problem_id, f.problemId),
    );
    assertEquals(rows.length, 1);

    // 主知识点废弃：挂载保留，读取按未归类。
    await getDb().update(knowledgeNodes).set({ status: "deprecated" }).where(
      eq(knowledgeNodes.id, "n.d"),
    );
    assertEquals(
      (await readProblemKnowledge(f.problemId, { userId: null }))?.state,
      "unclassified",
    );
    assertEquals(
      (await getDb().select().from(problemKnowledge).where(
        eq(problemKnowledge.problem_id, f.problemId),
      )).length,
      1,
    );
  },
});

Deno.test({
  name:
    "knowledge mappings: AI 结果不覆盖人工；阈值决定 auto/pending；替换旧 AI 挂载",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    const applied = await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.a",
      secondary: ["n.b"],
      confidence: 0.9,
    }, 0.75);
    assertEquals(applied.outcome, "applied");
    let view = await readProblemKnowledge(f.problemId, { userId: null });
    assertEquals(view?.primary?.review_status, "auto");
    assertEquals(view?.primary?.source, "ai");
    assertEquals(view?.primary?.confidence, 90);
    assertEquals(view?.primary?.version_id, f.versionId);
    assertEquals(view?.pending, false);

    // 低置信度 → pending（pending 也计入已归类）。
    await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.c",
      secondary: [],
      confidence: 0.4,
    }, 0.75);
    view = await readProblemKnowledge(f.problemId, { userId: null });
    assertEquals(view?.primary?.node_id, "n.c");
    assertEquals(view?.primary?.review_status, "pending");
    assertEquals(view?.pending, true);
    assertEquals(view?.secondary, []);

    // 人工优先：已有 human 行 → skipped，数据不变。
    await setProblemKnowledgeManually(user(f.author), f.problemId, {
      primary: "n.d",
      secondary: [],
    }, META);
    const skipped = await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.a",
      secondary: [],
      confidence: 1,
    }, 0.75);
    assertEquals(skipped.outcome, "skipped");
    assertEquals(
      (await readProblemKnowledge(f.problemId, { userId: null }))?.primary
        ?.node_id,
      "n.d",
    );
  },
});

Deno.test({
  name: "knowledge mappings: 审核 accept → confirmed；修改等同人工挂载",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.a",
      secondary: ["n.b"],
      confidence: 0.1,
    }, 0.75);
    const queue = await listPendingMappings({ page: 1, limit: 20 });
    assertEquals(queue.total, 1);
    assertEquals(queue.items[0]?.problem_id, f.problemId);
    assertEquals(queue.items[0]?.title, "知识图谱题");

    const accepted = await reviewMapping(root(), f.problemId, "accept", META);
    assertEquals(accepted.primary?.review_status, "confirmed");
    assertEquals(accepted.pending, false);
    assertEquals(accepted.secondary[0]?.review_status, "confirmed");
    assertEquals(
      (await listPendingMappings({ page: 1, limit: 20 })).total,
      0,
    );

    await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.c",
      secondary: [],
      confidence: 0.1,
    }, 0.75);
    const edited = await reviewMapping(root(), f.problemId, {
      primary: "n.e",
      secondary: ["n.a"],
    }, META);
    assertEquals(edited.primary?.node_id, "n.e");
    assertEquals(edited.primary?.source, "human");
    assertEquals(edited.primary?.review_status, "confirmed");
  },
});

Deno.test({
  name: "knowledge mappings: 驳回后回到未归类（除非另有已确认主知识点）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await applyAiMapping(f.problemId, f.versionId, {
      primary: "n.a",
      secondary: [],
      confidence: 0.2,
    }, 0.75);
    const rejected = await reviewMapping(root(), f.problemId, "reject", META);
    assertEquals(rejected.state, "unclassified");
    assertEquals(rejected.primary, null);
    const rows = await getDb().select().from(problemKnowledge).where(
      eq(problemKnowledge.problem_id, f.problemId),
    );
    assertEquals(rows.every((row) => row.review_status === "rejected"), true);

    // 存在已确认主知识点时，驳回 pending 的次要挂载不改归类。
    await getDb().delete(problemKnowledge).where(
      eq(problemKnowledge.problem_id, f.problemId),
    );
    const now = new Date().toISOString();
    await getDb().insert(problemKnowledge).values([
      {
        problem_id: f.problemId,
        node_id: "n.a",
        role: "primary",
        source: "human",
        review_status: "confirmed",
        updated_at: now,
      },
      {
        problem_id: f.problemId,
        node_id: "n.b",
        role: "secondary",
        source: "ai",
        review_status: "pending",
        updated_at: now,
      },
    ]);
    const view = await reviewMapping(root(), f.problemId, "reject", META);
    assertEquals(view.state, "classified");
    assertEquals(view.primary?.node_id, "n.a");
    assertEquals(view.secondary, []);
  },
});

Deno.test({
  name: "knowledge mappings: 比赛保密保护期间对非编辑者隐藏",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setProblemKnowledgeManually(user(f.author), f.problemId, {
      primary: "n.a",
      secondary: [],
    }, META);
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 3600_000).toISOString();
    const end = new Date(Date.now() + 3600_000).toISOString();
    const bindingId = crypto.randomUUID();
    await getDb().insert(domainProblemBindings).values({
      id: bindingId,
      domain_id: f.school.id,
      problem_id: f.problemId,
      visibility: "members",
      created_by: f.author,
      created_at: now,
      updated_at: now,
    });
    const contestId = crypto.randomUUID();
    await getDb().insert(contests).values({
      id: contestId,
      domain_id: f.school.id,
      title: "保密赛",
      start_time: start,
      end_time: end,
      type: "acm",
      secrecy_enabled: true,
      created_at: now,
      updated_at: now,
      created_by: f.author,
    });
    await getDb().insert(contestProblems).values({
      domain_id: f.school.id,
      domain_problem_binding_id: bindingId,
      contest_id: contestId,
      problem_id: f.problemId,
      sort_order: 0,
      label: "A",
      score: 100,
      pinned_version_id: f.versionId,
    });
    assertEquals(
      await readProblemKnowledge(f.problemId, { userId: null }),
      null,
    );
    assertEquals(
      await readProblemKnowledge(f.problemId, { userId: f.member }),
      null,
    );
    // 编辑者仍可见。
    assertEquals(
      (await readProblemKnowledge(f.problemId, { userId: f.author }))?.primary
        ?.node_id,
      "n.a",
    );
    // 审核队列不暴露保护期题目。
    await getDb().update(problemKnowledge).set({ review_status: "pending" })
      .where(eq(problemKnowledge.problem_id, f.problemId));
    assertEquals(
      (await listPendingMappings({ page: 1, limit: 20 })).items.length,
      0,
    );
    await assertRejects(
      () => reviewMapping(root(), f.problemId, "accept", META),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "knowledge mappings: 题目不存在 → 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => readProblemKnowledge(crypto.randomUUID(), { userId: null }),
      NotFoundError,
    );
    await assertRejects(
      () =>
        applyAiMapping(crypto.randomUUID(), null, {
          primary: "n.a",
          confidence: 1,
        }, 0.75),
      NotFoundError,
    );
  },
});
