/**
 * 题目包导入后的草稿写入与显式发布（Handbook §6.2/§6.4/§6.8）。
 *
 * 导入流程直接写**共享草稿**（编程题经 createProblem/updateProblem、客观题小题
 * 连同 UUID key 一起写入），`problems import --publish` 只需发布当前草稿 revision。
 * 这里覆盖 AI 与客观题两种内容形态，以及"相同内容重复发布不制造空版本"、
 * "客观题小题 key 稳定（显式 key 保留、缺省生成 UUID）"。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { objectiveQuestions, problems } from "../../../../shared/db/schema.ts";
import { createProblem } from "../../index.ts";
import {
  importProblemBundle,
  publishImportedProblem,
  syncProblemDraftFromProjection,
} from "../../services/problems/problem-bundle.ts";
import { listVersionQuestions } from "../../../objective/index.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";

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
  name: "bundle publish: 客观题导入写草稿并以稳定 key 进入版本",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const encoder = new TextEncoder();
    // 真实题包：problem.json + questions.json（第一题显式 key，第二题缺省）
    const explicitKey = crypto.randomUUID();
    const bundle = zipSync({
      "problem.json": encoder.encode(JSON.stringify({
        format_version: 1,
        title: `导入客观题 ${ts}`,
        description: "套卷",
        is_objective: true,
        type: "U",
        difficulty: "easy",
        tags: [],
      })),
      "questions.json": encoder.encode(JSON.stringify([
        {
          key: explicitKey,
          type: "single",
          prompt: "1+1=?",
          options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
          answer: ["A"],
        },
        { type: "judge", prompt: "地球是圆的", answer: [true] },
      ])),
    });

    const created = await importProblemBundle(
      { name: "objective.zip", data: bundle },
      { userId: ROOT_USER_ID, userRole: "admin" },
    );

    // 导入即写草稿（旧表只是兼容镜像）
    const published = await publishImportedProblem(created.id, ROOT_USER_ID);
    const questions = await listVersionQuestions(published.version_id);
    assertEquals(questions.length, 2);
    // 显式 key 原样保留；缺省 key 生成 UUID（不是按序号猜测）
    assertEquals(questions[0].key, explicitKey);
    assertEquals(questions[1].key.length > 0, true);
    assertEquals(questions[1].key === explicitKey, false);
    assertEquals(questions[0].answer, ["A"]);
    assertEquals(questions[1].answer, [true]);

    // 重复发布相同内容 → unchanged，不制造空版本
    const again = await publishImportedProblem(created.id, ROOT_USER_ID);
    assertEquals(again.unchanged, true);
    assertEquals(again.version, published.version);

    await db.update(problems).set({ latest_version_id: null }).where(
      eq(problems.id, created.id),
    );
    await db.delete(objectiveQuestions).where(
      eq(objectiveQuestions.paper_id, created.id),
    );
    await db.delete(problems).where(eq(problems.id, created.id));
  },
});
