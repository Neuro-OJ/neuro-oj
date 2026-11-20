/**
 * 内容包导入测试（真实 PostgreSQL，经 `deno task test:domain knowledge` 运行）。
 *
 * 覆盖：首次导入官方包；重复导入无实际变化（updated_at 不变）；替换包使缺失
 * 节点废弃、其余正常；校验失败不写库。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@^1";
import { and, eq, inArray } from "drizzle-orm";
import { resetDbForTest } from "../../../tests/helpers/db.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  knowledgeAreas,
  knowledgeEdges,
  knowledgeNodes,
  knowledgePacks,
} from "../../shared/db/schema.ts";
import { importPack, KnowledgePackInvalidError } from "./import.ts";
import { loadPackFromDir, resolveOfficialPackDir } from "./pack.ts";

await resetDbForTest();

/** 把官方包复制到临时目录，按需删除节点后作为「替换包」使用。 */
async function copyOfficialPack(
  mutate: (pack: Record<string, unknown>) => void,
): Promise<string> {
  const source = resolveOfficialPackDir();
  const dir = await Deno.makeTempDir({ prefix: "noj-knowledge-replace-" });
  await Deno.copyFile(join(source, "pack.yaml"), join(dir, "pack.yaml"));
  await Deno.mkdir(join(dir, "areas"));
  for await (const entry of Deno.readDir(join(source, "areas"))) {
    if (!entry.isFile) continue;
    await Deno.copyFile(
      join(source, "areas", entry.name),
      join(dir, "areas", entry.name),
    );
  }
  const pack = await loadPackFromDir(dir);
  const serializable = {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    license: pack.license,
    syllabi: pack.syllabi,
  } as Record<string, unknown>;
  mutate(serializable);
  await Deno.writeTextFile(
    join(dir, "pack.yaml"),
    JSON.stringify(serializable),
  );
  return dir;
}

Deno.test("knowledge import: 首次导入官方包写入全部节点与边", async () => {
  await resetDbForTest();
  const stats = await importPack(resolveOfficialPackDir());
  const db = getDb();
  assertEquals(stats.packId, "official");
  assertEquals(stats.areas, 14);
  assertEquals(stats.nodes, 181);
  assertEquals(stats.nodes_inserted, 181);
  assertEquals(stats.nodes_deprecated, 0);

  const packs = await db.select().from(knowledgePacks);
  assertEquals(packs.length, 1);
  assertEquals(packs[0]!.active, true);
  const nodes = await db.select().from(knowledgeNodes);
  assertEquals(nodes.length, 181);
  assertEquals(nodes.every((node) => node.status === "active"), true);
  const areas = await db.select().from(knowledgeAreas);
  assertEquals(areas.length, 14);
  const edges = await db.select().from(knowledgeEdges);
  assertEquals(edges.length, stats.edges);
  assertEquals(stats.edges > 0, true);
});

Deno.test("knowledge import: 重复导入不产生实际变化", async () => {
  await resetDbForTest();
  await importPack(resolveOfficialPackDir());
  const db = getDb();
  const before = await db.select().from(knowledgeNodes);
  const beforeEdges = await db.select().from(knowledgeEdges).orderBy(
    knowledgeEdges.from_id,
    knowledgeEdges.to_id,
  );

  const stats = await importPack(resolveOfficialPackDir());
  assertEquals(stats.nodes_inserted, 0);
  assertEquals(stats.nodes_updated, 0);
  assertEquals(stats.nodes_deprecated, 0);
  assertEquals(stats.areas_inserted + stats.areas_updated, 0);

  const after = await db.select().from(knowledgeNodes);
  assertEquals(after.length, before.length);
  const updatedAt = new Map(before.map((row) => [row.id, row.updated_at]));
  assertEquals(
    after.filter((row) => updatedAt.get(row.id) !== row.updated_at).length,
    0,
  );
  const afterEdges = await db.select().from(knowledgeEdges).orderBy(
    knowledgeEdges.from_id,
    knowledgeEdges.to_id,
  );
  assertEquals(afterEdges, beforeEdges);
});

Deno.test("knowledge import: 替换包缺失的节点被废弃，其余正常", async () => {
  await resetDbForTest();
  await importPack(resolveOfficialPackDir());
  const db = getDb();
  // 选一个没有任何节点依赖它的叶子节点，避免删除后被 require 悬挂。
  const before = await db.select().from(knowledgeNodes);
  const required = new Set(
    (await db.select().from(knowledgeEdges)).map((edge) => edge.from_id),
  );
  const leaf = before.find((row) => !required.has(row.id))!;

  // 替换包：版本号变化，从所属领域文件里删掉该节点。
  const dir = await copyOfficialPack((pack) => {
    pack.version = "2026.12.0-test";
  });
  try {
    const areaFile = join(dir, "areas", `${leaf.area_id}.yaml`);
    const text = await Deno.readTextFile(areaFile);
    const area = parseYaml(text) as { nodes: { id: string }[] };
    const nodes = area.nodes.filter((node) => node.id !== leaf.id);
    await Deno.writeTextFile(
      areaFile,
      stringifyYaml({ ...area, nodes }),
    );

    const stats = await importPack(dir);
    assertEquals(stats.nodes_deprecated, 1);
    assertEquals(stats.nodes_inserted, 0);

    const [deprecated] = await db.select().from(knowledgeNodes).where(
      eq(knowledgeNodes.id, leaf.id),
    );
    assertEquals(deprecated.status, "deprecated");
    const active = await db.select().from(knowledgeNodes).where(
      and(
        eq(knowledgeNodes.status, "active"),
        inArray(knowledgeNodes.id, [leaf.id]),
      ),
    );
    assertEquals(active.length, 0);
    const total = await db.select().from(knowledgeNodes);
    assertEquals(total.length, before.length);
    const others = total.filter((row) => row.id !== leaf.id);
    assertEquals(others.every((row) => row.status === "active"), true);

    const packs = await db.select().from(knowledgePacks);
    assertEquals(packs.filter((row) => row.active).map((row) => row.id), [
      "official",
    ]);

    // 再次导入官方包：被删节点恢复为 active。
    const restored = await importPack(resolveOfficialPackDir());
    assertEquals(restored.nodes_inserted, 0);
    assertEquals(restored.nodes_restored, 1);
    const [back] = await db.select().from(knowledgeNodes).where(
      eq(knowledgeNodes.id, leaf.id),
    );
    assertEquals(back.status, "active");

    // 扩展包：节点写入生效图，包记录 extends。
    const extDir = await Deno.makeTempDir({ prefix: "noj-knowledge-ext-" });
    try {
      const version = (await loadPackFromDir(resolveOfficialPackDir())).version;
      await Deno.writeTextFile(
        join(extDir, "pack.yaml"),
        JSON.stringify({
          id: "school",
          name: "学校扩展包",
          version: "1.0.0",
          license: "CC-BY-SA-4.0",
          syllabi: {},
          extends: `official@${version}`,
        }),
      );
      await Deno.mkdir(join(extDir, "areas"));
      await Deno.writeTextFile(
        join(extDir, "areas", "school.yaml"),
        JSON.stringify({
          area: "school",
          name: "校本课",
          nodes: [{
            id: "school.extra",
            name: "校本知识点",
            summary: "扩展包追加的节点",
            syllabus: ["ioai"],
            requires: [leaf.id],
          }],
        }),
      );
      const extStats = await importPack(extDir);
      assertEquals(extStats.packId, "school");
      assertEquals(extStats.basePackId, "official");
      assertEquals(extStats.nodes, 182);
      const extPacks = await db.select().from(knowledgePacks);
      assertEquals(
        extPacks.filter((row) => row.active).map((row) => row.id),
        ["school"],
      );
      assertEquals(
        extPacks.find((row) => row.id === "school")!.extends,
        `official@${version}`,
      );
      const [extra] = await db.select().from(knowledgeNodes).where(
        eq(knowledgeNodes.id, "school.extra"),
      );
      assertEquals(extra.status, "active");
      const extEdges = await db.select().from(knowledgeEdges).where(
        eq(knowledgeEdges.to_id, "school.extra"),
      );
      assertEquals(extEdges.map((edge) => edge.from_id), [leaf.id]);
    } finally {
      await Deno.remove(extDir, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge import: 校验失败抛错且不写库", async () => {
  await resetDbForTest();
  const dir = await Deno.makeTempDir({ prefix: "noj-knowledge-bad-" });
  try {
    await Deno.writeTextFile(
      join(dir, "pack.yaml"),
      JSON.stringify({
        id: "bad",
        name: "坏包",
        version: "0.1.0",
        license: "CC-BY-SA-4.0",
        syllabi: { ioai: "IOAI" },
      }),
    );
    await Deno.mkdir(join(dir, "areas"));
    await Deno.writeTextFile(
      join(dir, "areas", "ml.yaml"),
      JSON.stringify({
        area: "ml",
        name: "机器学习",
        nodes: [
          {
            id: "ml.a",
            name: "A",
            summary: "S",
            syllabus: ["ioai"],
            requires: ["ml.missing"],
          },
          { id: "ml.a", name: "A2", summary: "S2", syllabus: ["ioai"] },
        ],
      }),
    );
    const error = await assertRejects(
      () => importPack(dir),
      KnowledgePackInvalidError,
    );
    assertEquals(error.errors.length >= 2, true);
    assertEquals(error.message.includes("ml.missing"), true);

    const db = getDb();
    assertEquals((await db.select().from(knowledgePacks)).length, 0);
    assertEquals((await db.select().from(knowledgeNodes)).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
