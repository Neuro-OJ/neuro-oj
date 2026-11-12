/**
 * 知识图谱只读 API 测试（真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 覆盖：整图结构（14 领域 / 181 节点 / requires）、节点详情与 dependents、
 * 不存在 → 404、总开关关闭 → 404 KNOWLEDGE_DISABLED 且重新开启后恢复、
 * 无已导入包 → 空结果、缓存失效后读到新数据。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../app.ts";
import { jsonRequest } from "../../../tests/helper.ts";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import { updateSetting } from "../../modules/platform/index.ts";
import { importPack } from "./import.ts";
import { resolveOfficialPackDir } from "./pack.ts";
import { invalidateKnowledgeGraphCache } from "./graph.ts";

await resetDbForTest();

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
