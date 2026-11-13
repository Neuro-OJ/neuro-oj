/**
 * 知识图谱只读 API 测试（真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 覆盖：整图结构（14 领域 / 181 节点 / requires）、节点详情与 dependents、
 * 不存在 → 404、总开关关闭 → 404 KNOWLEDGE_DISABLED 且重新开启后恢复、
 * 无已导入包 → 空结果、缓存失效后读到新数据。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../app.ts";
import { initRedisForTest, jsonRequest } from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { importPack } from "./import.ts";
import { resolveOfficialPackDir } from "./pack.ts";
import { invalidateKnowledgeGraphCache } from "./graph.ts";
import { applyAiMapping } from "./mappings.ts";
import { eq } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import {
  knowledgeNodes,
  problemKnowledge,
  problems,
  users,
} from "../../shared/db/schema.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { _resetBanCacheForTest } from "../../modules/access/identity/services/security/banCache.ts";
import { signToken as signLiveToken } from "../../modules/access/identity/services/security/jwt.ts";

/**
 * 签发测试用 token。
 *
 * `jwt.ts` 的 `signToken` 会实时查询用户表取 `session_version`；夹具顺序在
 * 同文件里跨越多次 `resetDbForTest()`，缓存的账号快照可能属于已清空的库。
 * 这里先清空进程内用户缓存，保证签发时读到当前库的账号。
 */
async function signToken(payload: { sub: string; role: string }) {
  return await signLiveToken(payload, {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

/** 拿到新 token 后清空身份缓存，下一次请求才会读到当前库的账号。 */
async function tokenFor(sub: string, role: string): Promise<string> {
  const token = await signToken({ sub, role });
  _resetBanCacheForTest();
  return token;
}
import {
  addDomainMember,
  createDomain,
  setMemberRole,
} from "../../modules/access/workspace/index.ts";

await resetDbForTest();
// 认证中间件校验 JTI 撤销（Redis）；与路由测试统一在模块顶层初始化。
await initRedisForTest();

const admin = () => userActorFromAuthenticatedId("0");

async function setEnabled(value: boolean): Promise<void> {
  // 经设置服务写入会重新加载缓存；直接插表不会命中 getSetting 的缓存。
  await updateSetting("knowledge_enabled", value, admin());
}

Deno.test({
  name: "knowledge api: 整图返回领域、active 节点与前置",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 数据库已重置，进程内图缓存（TTL 10 分钟）也必须同步清空，否则会读到上个用例的数据。
    invalidateKnowledgeGraphCache();
    await setEnabled(true);
    await importPack(resolveOfficialPackDir());
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals(res.status, 200);
    const data = (await res.json()).data;
    assertEquals(data.pack.id, "official");
    assertEquals(typeof data.pack.version, "string");
    assertEquals(data.areas.length, 14);
    assertEquals(data.nodes.length, 181);
    assertEquals(
      data.nodes.some((node: { requires: string[] }) =>
        node.requires.length > 0
      ),
      true,
    );
    const sorts = data.areas.map((area: { sort: number }) => area.sort);
    assertEquals(
      sorts.every((value: number, i: number) =>
        i === 0 || sorts[i - 1]! <= value
      ),
      true,
    );
    const first = data.nodes[0];
    for (
      const key of [
        "id",
        "area",
        "name",
        "summary",
        "syllabus",
        "requires",
        "doc",
      ]
    ) {
      assertEquals(key in first, true, `节点缺少字段 ${key}`);
    }
  },
});

Deno.test({
  name: "knowledge api: 节点详情含 dependents；不存在或废弃返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 数据库已重置，进程内图缓存（TTL 10 分钟）也必须同步清空，否则会读到上个用例的数据。
    invalidateKnowledgeGraphCache();
    await setEnabled(true);
    await importPack(resolveOfficialPackDir());
    const app = createApp();
    const graph =
      (await (await jsonRequest(app, "/api/v1/knowledge/graph")).json()).data;
    const withRequires = graph.nodes.find(
      (node: { requires: string[] }) => node.requires.length > 0,
    );
    const prerequisite = withRequires.requires[0];

    const detail = await jsonRequest(
      app,
      `/api/v1/knowledge/nodes/${encodeURIComponent(withRequires.id)}`,
    );
    assertEquals(detail.status, 200);
    const data = (await detail.json()).data;
    assertEquals(data.id, withRequires.id);
    assertEquals(data.requires.includes(prerequisite), true);

    const dep = await jsonRequest(
      app,
      `/api/v1/knowledge/nodes/${encodeURIComponent(prerequisite)}`,
    );
    assertEquals(dep.status, 200);
    assertEquals(
      (await dep.json()).data.dependents.includes(withRequires.id),
      true,
    );

    const missing = await jsonRequest(
      app,
      "/api/v1/knowledge/nodes/no.such.node",
    );
    assertEquals(missing.status, 404);
  },
});

Deno.test({
  name: "knowledge api: 总开关关闭返回 404 KNOWLEDGE_DISABLED，重新开启后恢复",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 数据库已重置，进程内图缓存（TTL 10 分钟）也必须同步清空，否则会读到上个用例的数据。
    invalidateKnowledgeGraphCache();
    await importPack(resolveOfficialPackDir());
    const app = createApp();
    await setEnabled(false);
    try {
      const graph = await jsonRequest(app, "/api/v1/knowledge/graph");
      assertEquals(graph.status, 404);
      assertEquals((await graph.json()).code, "KNOWLEDGE_DISABLED");
      const node = await jsonRequest(app, "/api/v1/knowledge/nodes/a");
      assertEquals(node.status, 404);
      assertEquals((await node.json()).code, "KNOWLEDGE_DISABLED");
    } finally {
      await setEnabled(true);
    }
    const restored = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals(restored.status, 200);
  },
});

Deno.test({
  name: "knowledge api: 无已导入包返回空图与 pack null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 数据库已重置，进程内图缓存（TTL 10 分钟）也必须同步清空，否则会读到上个用例的数据。
    invalidateKnowledgeGraphCache();
    await setEnabled(true);
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals(res.status, 200);
    const data = (await res.json()).data;
    assertEquals(data.pack, null);
    assertEquals(data.areas, []);
    assertEquals(data.nodes, []);
  },
});

Deno.test({
  name: "knowledge api: 缓存失效后读到新导入数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 数据库已重置，进程内图缓存（TTL 10 分钟）也必须同步清空，否则会读到上个用例的数据。
    invalidateKnowledgeGraphCache();
    await setEnabled(true);
    const app = createApp();
    const empty = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals((await empty.json()).data.nodes.length, 0);
    await importPack(resolveOfficialPackDir());
    const cached = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals((await cached.json()).data.nodes.length, 181);
    // 手工重置缓存后仍能从库读到完整数据。
    invalidateKnowledgeGraphCache();
    const fresh = await jsonRequest(app, "/api/v1/knowledge/graph");
    assertEquals((await fresh.json()).data.nodes.length, 181);
  },
});

// ── P1：题目挂载与审核路由 ─────────────────────────────────────────────

/** 路由测试夹具：一个域、出题人（educator）、普通成员、一道题与知识节点。 */
async function mappingFixture() {
  await resetDbForTest();
  invalidateKnowledgeGraphCache();
  await setEnabled(true);
  await updateSetting("domain_creation_policy", "open", admin());
  const now = new Date().toISOString();
  const makeUser = async () => {
    const id = crypto.randomUUID();
    await getDb().insert(users).values({
      id,
      username: id,
      email: `${id}@example.com`,
      created_at: now,
      updated_at: now,
    });
    return id;
  };
  const owner = await makeUser();
  // 第一个账号建域后提升为平台管理员，充当实例管理员。
  await getDb().update(users).set({ role: "admin" }).where(
    eq(users.id, owner),
  );
  const author = await makeUser();
  const member = await makeUser();
  const school = await createDomain({
    slug: "kg-api",
    name: "知识图谱 API",
    preset: "education",
  }, owner);
  await addDomainMember(getDb(), school.id, author);
  await addDomainMember(getDb(), school.id, member);
  await setMemberRole(school.slug, owner, author, "educator");
  // 角色提升发生在建域之后，清空进程内用户/封禁缓存后再首次签发 token，
  // 否则认证中间件会读到上个用例缓存的旧账号快照。
  _resetBanCacheForTest();
  await importPack(resolveOfficialPackDir());
  _resetBanCacheForTest();
  const nodeIds = (await getDb().select({ id: knowledgeNodes.id })
    .from(knowledgeNodes).limit(5)).map((row) => row.id);
  const problemId = crypto.randomUUID();
  await getDb().insert(problems).values({
    id: problemId,
    domain_id: school.id,
    number: 1,
    title: "挂载题",
    description: "题面",
    owner_id: author,
    created_at: now,
    updated_at: now,
  });
  return { owner, author, member, problemId, nodeIds, school };
}

Deno.test({
  name: "knowledge api: 题目挂载读/写权限与参数校验",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await mappingFixture();
    const app = createApp();
    const authorToken = await tokenFor(f.author, "user");
    const memberToken = await signToken({ sub: f.member, role: "user" });
    const path = `/api/v1/knowledge/problems/${f.problemId}`;

    // 未挂载：未登录可读，未归类。
    const empty = await jsonRequest(app, path);
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).data.state, "unclassified");

    // 未登录写 → 401；非法 problemId → 400。
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PUT",
        body: { primary: f.nodeIds[0] },
      })).status,
      401,
    );
    assertEquals(
      (await jsonRequest(app, "/api/v1/knowledge/problems/not-a-uuid", {
        method: "PUT",
        token: authorToken,
        body: { primary: f.nodeIds[0] },
      })).status,
      400,
    );

    // 普通成员 → 403。
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PUT",
        token: memberToken,
        body: { primary: f.nodeIds[0] },
      })).status,
      403,
    );

    // 校验错误 → 400（secondary 含 primary）。
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PUT",
        token: authorToken,
        body: { primary: f.nodeIds[0], secondary: [f.nodeIds[0]] },
      })).status,
      400,
    );

    // 出题人挂载成功。
    const written = await jsonRequest(app, path, {
      method: "PUT",
      token: authorToken,
      body: { primary: f.nodeIds[0], secondary: [f.nodeIds[1]] },
    });
    assertEquals(written.status, 200);
    const data = (await written.json()).data;
    assertEquals(data.state, "classified");
    assertEquals(data.primary.node_id, f.nodeIds[0]);
    assertEquals(data.primary.source, "human");
    assertEquals(data.secondary.length, 1);

    // 非 UUID → 400；合法 UUID 但不存在 → 404（单独断言于服务层测试）。
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/knowledge/problems/${crypto.randomUUID()}x`,
      ))
        .status,
      400,
    );
  },
});

Deno.test({
  name: "knowledge api: 审核队列仅实例管理员；accept/reject 生效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await mappingFixture();
    const app = createApp();
    const authorToken = await tokenFor(f.author, "user");
    const adminToken = await tokenFor(f.owner, "admin");
    await applyAiMapping(f.problemId, null, {
      primary: f.nodeIds[0],
      secondary: [f.nodeIds[1]],
      confidence: 0.2,
    }, 0.75);

    assertEquals(
      (await jsonRequest(app, "/api/v1/admin/knowledge/reviews")).status,
      401,
    );
    assertEquals(
      (await jsonRequest(app, "/api/v1/admin/knowledge/reviews", {
        token: authorToken,
      })).status,
      403,
    );
    const queue = await jsonRequest(app, "/api/v1/admin/knowledge/reviews", {
      token: adminToken,
    });
    assertEquals(queue.status, 200);
    const listed = (await queue.json()).data;
    assertEquals(listed.total, 1);
    assertEquals(listed.items[0].problem_id, f.problemId);

    const accepted = await jsonRequest(
      app,
      `/api/v1/admin/knowledge/reviews/${f.problemId}`,
      { method: "POST", token: adminToken, body: { decision: "accept" } },
    );
    assertEquals(accepted.status, 200);
    assertEquals(
      (await accepted.json()).data.primary.review_status,
      "confirmed",
    );

    // 重新打标为 pending 后修改：等同人工挂载。
    await applyAiMapping(f.problemId, null, {
      primary: f.nodeIds[0],
      confidence: 0.1,
    }, 0.75);
    const edited = await jsonRequest(
      app,
      `/api/v1/admin/knowledge/reviews/${f.problemId}`,
      {
        method: "POST",
        token: adminToken,
        body: { primary: f.nodeIds[2], secondary: [] },
      },
    );
    assertEquals(edited.status, 200);
    assertEquals((await edited.json()).data.primary.node_id, f.nodeIds[2]);

    // 驳回 → 未归类：清掉人工挂载后重新打标为 pending，再驳回。
    await getDb().delete(problemKnowledge).where(
      eq(problemKnowledge.problem_id, f.problemId),
    );
    await applyAiMapping(f.problemId, null, {
      primary: f.nodeIds[0],
      confidence: 0.1,
    }, 0.75);
    const rejected = await jsonRequest(
      app,
      `/api/v1/admin/knowledge/reviews/${f.problemId}`,
      { method: "POST", token: adminToken, body: { decision: "reject" } },
    );
    assertEquals(rejected.status, 200);
    assertEquals((await rejected.json()).data.state, "unclassified");
  },
});

Deno.test({
  name: "knowledge api: 总开关关闭时挂载与审核接口 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await mappingFixture();
    const app = createApp();
    const adminToken = await tokenFor(f.owner, "admin");
    await setEnabled(false);
    try {
      const read = await jsonRequest(
        app,
        `/api/v1/knowledge/problems/${f.problemId}`,
      );
      assertEquals(read.status, 404);
      assertEquals((await read.json()).code, "KNOWLEDGE_DISABLED");
      const queue = await jsonRequest(
        app,
        "/api/v1/admin/knowledge/reviews",
        { token: adminToken },
      );
      assertEquals(queue.status, 404);
      assertEquals((await queue.json()).code, "KNOWLEDGE_DISABLED");
    } finally {
      await setEnabled(true);
    }
  },
});
