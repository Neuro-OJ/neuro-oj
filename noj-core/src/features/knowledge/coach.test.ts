/**
 * 教练视角测试（P4，真实 PostgreSQL）：班级掌握矩阵与按知识点挑题。
 *
 * 覆盖：权限矩阵（教练可见、学生 403、非成员 404、未登录 401、总开关关闭
 * 404）、只列活跃学生、cells 稀疏与 counts 之和、空节点不出现、挑题均匀抽样
 * （7 取 3 → 0/3/6）、候选不足全返回、count=1 中位、越界 400、废弃节点 404、
 * 进行中比赛题不出现。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../app.ts";
import {
  initRedisForTest,
  insertContestProblems,
  jsonRequest,
} from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  classroomMemberships,
  contests,
  domainProblemBindings,
  knowledgeAreas,
  knowledgeNodes,
  knowledgePacks,
  problemDifficulty,
  problemKnowledge,
  problems,
  problemVersions,
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
import {
  createClassroom,
  setClassroomMember,
} from "../../modules/education/index.ts";
import { invalidateKnowledgeGraphCache } from "./graph.ts";
import { type ClassMasteryView, sampleEvenly } from "./coach.ts";

await resetDbForTest();
await initRedisForTest();

const admin = () => userActorFromAuthenticatedId("0");
const NOW = () => new Date().toISOString();

function db() {
  return getDb();
}

async function tokenFor(sub: string): Promise<string> {
  const token = await signLiveToken({ sub, role: "user" }, {
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

/** 内容包 + 领域 + 节点。 */
async function seedGraph(input: {
  areas: Array<{ id: string; name: string; sort: number }>;
  nodes: Array<
    { id: string; area: string; name?: string; sort?: number; status?: string }
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
      name: area.name,
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
      status: node.status ?? "active",
      sort: node.sort ?? 0,
      doc_path: null,
      updated_at: now,
    }).onConflictDoNothing();
  }
  invalidateKnowledgeGraphCache();
}

/** 题目夹具：发布 + 域绑定 + 主知识点挂载（可指定校准难度）。 */
async function mkProblem(input: {
  domainId: string;
  number: number;
  nodeId: string;
  calibrated?: number;
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
    owner_id: "0",
    is_objective: false,
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
  await d.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
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
  await d.insert(problemKnowledge).values({
    problem_id: problemId,
    node_id: input.nodeId,
    role: "primary",
    source: "human",
    confidence: null,
    version_id: versionId,
    review_status: "confirmed",
    updated_at: now,
  });
  if (input.calibrated !== undefined) {
    await d.insert(problemDifficulty).values({
      problem_id: problemId,
      prior: input.calibrated,
      calibrated: input.calibrated,
      sample_size: 3,
      pass_ratio_override: null,
      updated_at: now,
    });
  }
  return { problemId, bindingId, versionId };
}

/** 班级夹具：域 + 教练 + 班级 + 学生成员关系。 */
async function coachFixture(slug: string) {
  await updateSetting("domain_creation_policy", "open", admin());
  await updateSetting("knowledge_enabled", true, admin());
  const domain = await createDomain(
    { slug, name: slug, preset: "education" },
    "0",
  );
  const coach = await mkUser();
  await addDomainMember(db(), domain.id, coach);
  await setMemberRole(domain.slug, "0", coach, "educator");
  const classroom = await createClassroom(domain.slug, coach, { name: "一班" });
  return { domain, coach, classroom };
}

Deno.test({
  name: "knowledge coach: 挑题均匀抽样纯函数（7 取 3 → 0/3/6）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const items = [10, 20, 30, 40, 50, 60, 70];
    assertEquals(sampleEvenly(items, 3), [10, 40, 70]);
    // count=1 取中位；偶数个取靠后一道。
    assertEquals(sampleEvenly(items, 1), [40]);
    assertEquals(sampleEvenly([10, 20], 1), [20]);
    // 候选不足：全部返回且保持原序。
    assertEquals(sampleEvenly([10, 20], 5), [10, 20]);
    assertEquals(sampleEvenly([], 5), []);
  },
});

Deno.test({
  name: "knowledge coach: 掌握矩阵权限矩阵、活跃学生、稀疏 cells 与 counts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    invalidateKnowledgeGraphCache();
    const f = await coachFixture("kg-coach");
    await seedGraph({
      areas: [
        { id: "a1", name: "领域一", sort: 1 },
        { id: "a2", name: "领域二", sort: 2 },
      ],
      nodes: [
        { id: "n1", area: "a1", name: "节点一" },
        { id: "n2", area: "a1", name: "节点二" },
        // 无题、无记录：不应出现。
        { id: "empty", area: "a1", name: "空节点" },
        // 只有记录、没有题：应出现（problem_count=0）。
        { id: "rec", area: "a2", name: "有记录无题" },
        // a2 里的空节点：整领域不出现。
        { id: "empty2", area: "a2", name: "空节点二" },
      ],
    });
    await mkProblem({
      domainId: f.domain.id,
      number: 1,
      nodeId: "n1",
      calibrated: 30,
    });
    await mkProblem({
      domainId: f.domain.id,
      number: 2,
      nodeId: "n1",
      calibrated: 50,
    });
    await mkProblem({
      domainId: f.domain.id,
      number: 3,
      nodeId: "n2",
      calibrated: 70,
    });

    const s1 = await mkUser();
    const s2 = await mkUser();
    const removed = await mkUser();
    const outsider = await mkUser();
    // 班级成员服务要求加入者是本域有效成员。
    for (const member of [s1, s2, removed]) {
      await addDomainMember(db(), f.domain.id, member);
    }
    await setClassroomMember(f.domain.slug, f.classroom.id, f.coach, s1, 0, {
      role: "student",
    });
    await setClassroomMember(f.domain.slug, f.classroom.id, f.coach, s2, 1, {
      role: "student",
    });
    await setClassroomMember(
      f.domain.slug,
      f.classroom.id,
      f.coach,
      removed,
      2,
      {
        role: "student",
      },
    );
    await db().update(classroomMemberships).set({ status: "removed" }).where(
      and(
        eq(classroomMemberships.classroom_id, f.classroom.id),
        eq(classroomMemberships.user_id, removed),
      ),
    );
    const now = NOW();
    await db().insert(userKnowledgeMastery).values([
      { user_id: s1, node_id: "n1", state: "mastered", updated_at: now },
      { user_id: s2, node_id: "n1", state: "learning", updated_at: now },
      { user_id: s1, node_id: "rec", state: "learning", updated_at: now },
      // 已离班学生的记录不进矩阵。
      { user_id: removed, node_id: "n2", state: "mastered", updated_at: now },
    ]);

    const app = createApp();
    const path =
      `/api/v1/domains/${f.domain.slug}/classrooms/${f.classroom.id}`;

    // 教练可见。
    const res = await jsonRequest(app, `${path}/knowledge-mastery`, {
      token: await tokenFor(f.coach),
    });
    assertEquals(res.status, 200);
    const data = (await res.json()).data as ClassMasteryView;
    assertEquals(data.classroom_id, f.classroom.id);
    // 只列活跃学生（已离班的 removed 不出现），按 username 排序。
    const expectedStudents = [s1, s2].sort();
    assertEquals(data.students.map((s) => s.user_id), expectedStudents);
    assertEquals(data.students.every((s) => s.display_name === null), true);
    // 领域与节点按 sort 排序；空节点与空领域不出现。
    assertEquals(data.areas.map((area) => area.id), ["a1", "a2"]);
    assertEquals(
      data.areas[0]!.nodes.map((node) => node.id),
      ["n1", "n2"],
    );
    assertEquals(data.areas[1]!.nodes.map((node) => node.id), ["rec"]);
    const n1 = data.areas[0]!.nodes[0]!;
    assertEquals(n1.problem_count, 2);
    assertEquals(n1.counts, { mastered: 1, learning: 1, none: 0 });
    const rec = data.areas[1]!.nodes[0]!;
    assertEquals(rec.problem_count, 0);
    assertEquals(rec.counts, { mastered: 0, learning: 1, none: 1 });
    for (const area of data.areas) {
      for (const node of area.nodes) {
        const { mastered, learning, none } = node.counts;
        assertEquals(mastered + learning + none, data.students.length);
      }
    }
    // cells 稀疏：只含 learning / mastered，none 省略。
    assertEquals(data.cells, {
      [s1]: { n1: "mastered", rec: "learning" },
      [s2]: { n1: "learning" },
    });
    assertEquals(JSON.stringify(data.cells).includes("none"), false);

    // 学生 → 403。
    const studentRes = await jsonRequest(app, `${path}/knowledge-mastery`, {
      token: await tokenFor(s1),
    });
    assertEquals(studentRes.status, 403);
    assertEquals((await studentRes.json()).code, "CLASSROOM_PERMISSION_DENIED");
    // 非成员（未加域）→ 404。
    assertEquals(
      (await jsonRequest(app, `${path}/knowledge-mastery`, {
        token: await tokenFor(outsider),
      })).status,
      404,
    );
    // 未登录 → 401。
    assertEquals(
      (await jsonRequest(app, `${path}/knowledge-mastery`)).status,
      401,
    );
    // 总开关关闭 → 404 KNOWLEDGE_DISABLED。
    await updateSetting("knowledge_enabled", false, admin());
    const disabled = await jsonRequest(app, `${path}/knowledge-mastery`, {
      token: await tokenFor(f.coach),
    });
    assertEquals(disabled.status, 404);
    assertEquals((await disabled.json()).code, "KNOWLEDGE_DISABLED");
    await updateSetting("knowledge_enabled", true, admin());
  },
});

Deno.test({
  name: "knowledge coach: 挑题抽样、候选不足、count=1、边界与进行中比赛题",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    invalidateKnowledgeGraphCache();
    const f = await coachFixture("kg-pick");
    await seedGraph({
      areas: [{ id: "a1", name: "领域一", sort: 1 }],
      nodes: [
        { id: "n1", area: "a1", name: "抽样节点" },
        { id: "n2", area: "a1", name: "少量节点" },
        { id: "gone", area: "a1", name: "废弃节点", status: "deprecated" },
      ],
    });
    const seven = [];
    for (let i = 0; i < 7; i++) {
      seven.push(
        (await mkProblem({
          domainId: f.domain.id,
          number: 100 + i,
          nodeId: "n1",
          calibrated: 10 + i * 10,
        })).problemId,
      );
    }
    const two = [
      (await mkProblem({
        domainId: f.domain.id,
        number: 1,
        nodeId: "n2",
        calibrated: 20,
      })).problemId,
      (await mkProblem({
        domainId: f.domain.id,
        number: 2,
        nodeId: "n2",
        calibrated: 60,
      })).problemId,
    ];
    // 进行中比赛（保密）里的题不进候选。
    const secret = await mkProblem({
      domainId: f.domain.id,
      number: 999,
      nodeId: "n1",
      calibrated: 45,
    });
    const contestId = crypto.randomUUID();
    const now = Date.now();
    await db().insert(contests).values({
      id: contestId,
      public_id: `c-${contestId.slice(0, 8)}`,
      domain_id: f.domain.id,
      title: "进行中",
      type: "oi",
      kind: "public",
      start_time: new Date(now - 3600_000).toISOString(),
      end_time: new Date(now + 3600_000).toISOString(),
      owner_id: "0",
      secrecy_enabled: true,
      created_at: NOW(),
      updated_at: NOW(),
    } as never);
    await insertContestProblems({
      contest_id: contestId,
      problem_id: secret.problemId,
      label: "A",
      score: 100,
      pinned_version_id: secret.versionId,
    });

    const app = createApp();
    const token = await tokenFor(f.coach);
    const base =
      `/api/v1/domains/${f.domain.slug}/classrooms/${f.classroom.id}/knowledge-pick`;

    // 7 取 3 → 下标 0/3/6，难度 10/40/70。
    const sampled = await jsonRequest(app, `${base}?node=n1&count=3`, {
      token,
    });
    assertEquals(sampled.status, 200);
    const sampledData = (await sampled.json()).data;
    assertEquals(sampledData.node_id, "n1");
    assertEquals(sampledData.node_name, "抽样节点");
    assertEquals(
      sampledData.items.map((item: { number: number }) => item.number),
      [100, 103, 106],
    );
    assertEquals(
      sampledData.items.map((item: { difficulty: number }) => item.difficulty),
      [10, 40, 70],
    );
    assertEquals(sampledData.items[0].tier, "easy");
    assertEquals(sampledData.items[2].tier, "hard");
    // 本域题的编辑器引用就是题号（跨域共享题才带「来源域:」前缀）。
    assertEquals(
      sampledData.items[0].display_ref,
      String(sampledData.items[0].number),
    );
    const firstKeys = Object.keys(sampledData.items[0]).sort();
    assertEquals(firstKeys, [
      "difficulty",
      "display_ref",
      "number",
      "problem_id",
      "tier",
      "title",
    ]);

    // 默认 count=5：7 道里取 5（含首尾）。
    const defaultCount = await jsonRequest(app, `${base}?node=n1`, { token });
    const defaultItems = (await defaultCount.json()).data.items;
    assertEquals(defaultItems.length, 5);
    assertEquals(defaultItems[0].number, 100);
    assertEquals(defaultItems[4].number, 106);

    // 候选不足 → 全部返回；count=1 → 中位（7 道取第 4 道）。
    const all = await jsonRequest(app, `${base}?node=n2&count=5`, { token });
    assertEquals(
      (await all.json()).data.items.map((item: { problem_id: string }) =>
        item.problem_id
      ),
      two,
    );
    const middle = await jsonRequest(app, `${base}?node=n1&count=1`, { token });
    assertEquals(
      (await middle.json()).data.items.map((item: { number: number }) =>
        item.number
      ),
      [103],
    );

    // 进行中比赛题不出现（含 count 上限时）。
    const capped = await jsonRequest(app, `${base}?node=n1&count=20`, {
      token,
    });
    const cappedItems = (await capped.json()).data.items;
    assertEquals(cappedItems.length, 7);
    assertEquals(
      cappedItems.some(
        (item: { problem_id: string }) => item.problem_id === secret.problemId,
      ),
      false,
    );

    // 越界 / 非法 count → 400；缺 node → 400；废弃节点 → 404。
    for (const query of ["count=0", "count=21", "count=abc", "count=1.5"]) {
      assertEquals(
        (await jsonRequest(app, `${base}?node=n1&${query}`, { token }))
          .status,
        400,
        query,
      );
    }
    assertEquals((await jsonRequest(app, base, { token })).status, 400);
    assertEquals(
      (await jsonRequest(app, `${base}?node=gone`, { token })).status,
      404,
    );
    assertEquals(
      (await jsonRequest(app, `${base}?node=nope`, { token })).status,
      404,
    );

    // 挑题同样走权限矩阵：学生 403、未登录 401。
    const student = await mkUser();
    await addDomainMember(db(), f.domain.id, student);
    await setClassroomMember(
      f.domain.slug,
      f.classroom.id,
      f.coach,
      student,
      0,
      {
        role: "student",
      },
    );
    assertEquals(
      (await jsonRequest(app, `${base}?node=n1`, {
        token: await tokenFor(student),
      })).status,
      403,
    );
    assertEquals((await jsonRequest(app, `${base}?node=n1`)).status, 401);
  },
});
