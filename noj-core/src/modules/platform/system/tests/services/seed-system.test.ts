/**
 * seed-system 幂等与批量写入集成测试。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { judgeImages, tags } from "../../../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { seedJudgeImages, seedTags } from "../../services/seed/seed-system.ts";

/** 兼容镜像与生产镜像的固定 ID（与 seedJudgeImages / tests/helpers/db.ts 一致）。 */
const IMAGE_IDS = {
  compatJudge: "e0000000-0000-0000-0000-000000000001",
  evaluator: "e0000000-0000-0000-0000-000000000002",
  solution: "e0000000-0000-0000-0000-000000000003",
  solutionAi: "e0000000-0000-0000-0000-000000000004",
} as const;

Deno.test("seed-system: seedJudgeImages 幂等且写入白名单", async () => {
  const db = getDb();
  await seedJudgeImages();
  const first = await db.select().from(judgeImages);
  await seedJudgeImages();
  const second = await db.select().from(judgeImages);
  assertEquals(second.length, first.length);
  assertEquals(
    second.some((r) => r.image.endsWith("noj-evaluator-python")),
    true,
  );
});

Deno.test("seed-system: seedTags 幂等且写入种子标签", async () => {
  const db = getDb();
  await seedTags();
  const first = await db.select().from(tags);
  await seedTags();
  const second = await db.select().from(tags);
  assertEquals(second.length, first.length);
  assertEquals(second.some((r) => r.name === "LMCC 样例题"), true);
});

Deno.test({
  name:
    "seed-system: 批量 upsert 冲突时保留原 image，只同步 kind/mode/description",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await resetDbForTest();
    const before = await db.select().from(judgeImages);
    assertEquals(before.length, 4, "reset 后应有三条兼容镜像 + AI 镜像");

    // 运维把手改过的镜像名写进白名单：批量 upsert 不得覆盖 image
    await db.update(judgeImages).set({
      image: "mirror.example/internal-evaluator",
      description: "运维旧描述",
      kind: "solution",
      mode: "exact",
    }).where(eq(judgeImages.id, IMAGE_IDS.evaluator));

    await seedJudgeImages();

    const [after] = await db
      .select()
      .from(judgeImages)
      .where(eq(judgeImages.id, IMAGE_IDS.evaluator));
    assert(after, "镜像行不应被删除");
    assertEquals(after.image, "mirror.example/internal-evaluator");
    assertEquals(after.kind, "evaluator");
    assertEquals(after.mode, "all_versions");
    assertEquals(
      after.description,
      "双容器 Evaluator (Python 3.12, noj_evaluator_sdk)",
    );
    assertEquals((await db.select().from(judgeImages)).length, 4);
  },
});

Deno.test({
  name: "seed-system: 批量 upsert 应用 JUDGE_IMAGE_BASE 前缀且不重复插入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await resetDbForTest();
    const previousBase = Deno.env.get("JUDGE_IMAGE_BASE");
    Deno.env.set("JUDGE_IMAGE_BASE", "ghcr.io/neuro-oj/");
    try {
      // 删掉 AI 镜像行，验证新插入同样走批量 values([...])
      await db.delete(judgeImages).where(
        eq(judgeImages.id, IMAGE_IDS.solutionAi),
      );
      await db.delete(judgeImages).where(
        eq(judgeImages.id, IMAGE_IDS.compatJudge),
      );
      await seedJudgeImages();
      await seedJudgeImages();

      const rows = await db.select().from(judgeImages);
      assertEquals(rows.length, 3, "两条被删镜像应重新插入且不产生重复");
      const ai = rows.find((row) => row.id === IMAGE_IDS.solutionAi);
      assert(ai, "缺少 AI solution 镜像");
      assertEquals(ai.image, "ghcr.io/neuro-oj/noj-solution-ai");
      assertEquals(ai.kind, "solution");
      const evaluator = rows.find((row) => row.id === IMAGE_IDS.evaluator);
      assert(evaluator, "缺少 evaluator 镜像");
      assertEquals(evaluator.kind, "evaluator");
    } finally {
      if (previousBase === undefined) Deno.env.delete("JUDGE_IMAGE_BASE");
      else Deno.env.set("JUDGE_IMAGE_BASE", previousBase);
    }
  },
});
