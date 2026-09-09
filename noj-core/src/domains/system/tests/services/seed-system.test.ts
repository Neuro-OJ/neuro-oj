/**
 * seed-system 幂等集成测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb } from "../../../../shared/db/connection.ts";
import { judgeImages, tags } from "../../../../shared/db/schema.ts";
import { seedJudgeImages, seedTags } from "../../services/seed/seed-system.ts";

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
