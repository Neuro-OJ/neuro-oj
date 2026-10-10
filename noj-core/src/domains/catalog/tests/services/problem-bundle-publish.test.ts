/**
 * 题目包导入后的草稿同步与显式发布（Handbook §6.8）。
 *
 * 导入流程写的是题目投影（兼容期读路径），`problems import --publish` 需要先把同一份
 * 内容同步进共享草稿再发布：否则发布的版本会缺少导入内容（客观题甚至会是没有小题的
 * 空卷）。这里覆盖 AI 与客观题两种内容形态，以及"相同内容重复发布不制造空版本"。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { objectiveQuestions, problems } from "../../../../shared/db/schema.ts";
import { createProblem } from "../../index.ts";
import {
  publishImportedProblem,
  syncProblemDraftFromProjection,
} from "../../services/problems/problem-bundle.ts";
import { listVersionQuestions } from "../../../objective/index.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

const now = new Date().toISOString();
const ts = Date.now();

await resetDbForTest();
const db = getDb();

const runtimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

Deno.test({
  name: "bundle publish: 导入后同步草稿并显式发布 V1（AI 题）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const created = await createProblem({
      title: `导入发布题 ${ts}`,
      description: "原始题面",
      difficulty: "easy",
      samples: [],
      runtime_config: runtimeConfig,
    });

    // 模拟导入流程写投影（兼容期路径）：改题面 + 改语言
    const importedTitle = `导入后的题面 ${ts}`;
    await db.update(problems).set({
      title: importedTitle,
      description: "导入后的描述",
      updated_at: now,
    }).where(eq(problems.id, created.id));

    const revision = await syncProblemDraftFromProjection(created.id, "0");
    assertEquals(revision > 0, true);

    const published = await publishImportedProblem(created.id, "0");
    assertEquals(published.version, 1);
    assertEquals(published.unchanged, false);

    // 版本内容必须等于**导入内容**（不是创建时的旧题面）
    const { getProblemVersionOrThrow } = await import(
      "../../services/versioning/publish.ts"
    );
    const version = await getProblemVersionOrThrow(
      created.id,
      published.version_id,
    );
    assertEquals(
      (version.content as { title: string }).title,
      importedTitle,
    );

    // 相同内容重复发布：复用既有版本，不制造空版本
    const again = await publishImportedProblem(created.id, "0");
    assertEquals(again.unchanged, true);
    assertEquals(again.version_id, published.version_id);

    await db.update(problems).set({ latest_version_id: null }).where(
      eq(problems.id, created.id),
    );
    await db.delete(problems).where(eq(problems.id, created.id));
  },
});

Deno.test({
  name: "bundle publish: 客观题小题以旧 UUID 作 key 进入版本",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const created = await createProblem({
      title: `导入客观题 ${ts}`,
      description: "套卷",
      difficulty: "easy",
      is_objective: true,
      visibility: "public",
    });

    // 模拟题包导入：小题写入旧表（UUID 即稳定 key）
    const q1 = crypto.randomUUID();
    const q2 = crypto.randomUUID();
    await db.insert(objectiveQuestions).values([
      {
        id: q1,
        paper_id: created.id,
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "",
        created_at: now,
        updated_at: now,
      },
      {
        id: q2,
        paper_id: created.id,
        sort_order: 1,
        type: "judge",
        prompt: "地球是圆的",
        options: [{ key: "true", text: "正确" }, {
          key: "false",
          text: "错误",
        }],
        answer: [true],
        explanation: "",
        created_at: now,
        updated_at: now,
      },
    ]);

    const published = await publishImportedProblem(created.id, "0");
    const questions = await listVersionQuestions(published.version_id);
    assertEquals(questions.map((q) => q.key), [q1, q2]);
    assertEquals(questions[0].answer, ["A"]);
    assertEquals(questions[1].answer, [true]);

    await db.update(problems).set({ latest_version_id: null }).where(
      eq(problems.id, created.id),
    );
    await db.delete(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, created.id),
    );
    await db.delete(problems).where(eq(problems.id, created.id));
  },
});
