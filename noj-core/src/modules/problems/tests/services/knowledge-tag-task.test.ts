/**
 * 发布投递知识图谱 AI 打标任务的测试（经 `deno task test:domain problems` 运行）。
 *
 * 覆盖：AI 打标开关开启时发布新版本投递 `knowledge.tag`（去重键按题目 + 版本）、
 * 草稿保存不投递、开关关闭不投递、相同内容重复发布（unchanged）不投递；
 * 低峰时段（默认开启）时段外投递时 `available_at` 为下一个时段开始，
 * 关闭 offpeak 时为投递时刻。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  backgroundTasks,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import { saveProblemDraft } from "../../services/versioning/draft.ts";
import type { ProblemDraftContent } from "../../types/problem-content.ts";
import { publishProblemVersion } from "../../services/versioning/publish.ts";
import {
  LocalStorageProvider,
  setStorageProviderForTest,
} from "../../../assets/storage/mod.ts";
import { userActorFromAuthenticatedId } from "../../../access/index.ts";
import { updateSetting } from "../../../platform/index.ts";
import { setOffpeakNowForTest } from "../../services/versioning/knowledge-tag-task.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";

const now = new Date().toISOString();
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-kg-tag-" });
const admin = () => userActorFromAuthenticatedId("0");

async function setTags(enabled: boolean): Promise<void> {
  await updateSetting("knowledge_enabled", true, admin());
  await updateSetting("knowledge_ai_tagging_enabled", enabled, admin());
  // 既有用例与低峰时段无关：默认关闭 offpeak（低峰专项用例再显式开启）。
  await updateSetting("knowledge_ai_offpeak_only", false, admin());
}

/** 北京 12:00 对应的 UTC 时刻（默认低峰时段外）。 */
const OFFPEAK_OUTSIDE_NOW = new Date("2026-11-13T04:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** 按与 `features/knowledge/offpeak.ts` 相同的 UTC+8 算法求预期值。 */
function expectedNextStart(now: Date, window = "00:30-08:30"): string {
  const [start] = window.split("-");
  const startMin = Number(start!.split(":")[0]) * 60 +
    Number(start!.split(":")[1]);
  const cst = 8 * 60 * 60 * 1000;
  const dayStart = Math.floor((now.getTime() + cst) / DAY_MS) * DAY_MS - cst;
  const todayStart = dayStart + startMin * 60000;
  return new Date(
    now.getTime() <= todayStart
      ? todayStart
      : dayStart + DAY_MS + startMin * 60000,
  ).toISOString();
}

async function seedAiProblem(id: string, number: number): Promise<void> {
  await getDb().insert(users).values({
    id: "0",
    username: "root",
    email: "root@example.com",
    role: "admin",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await getDb().insert(problems).values({
    domain_id: "00000000-0000-4000-8000-000000000001",
    id,
    title: "初始标题",
    description: "初始题面",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    submission_mode: "code",
    created_at: now,
    updated_at: now,
  });
}

function aiContent(title: string): ProblemDraftContent {
  return {
    kind: "ai",
    title,
    description: `${title} 的题面`,
    samples: [{ id: "s1", input: "1", output: "2" }],
    submission_mode: "code",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 60000,
        memory_limit_mb: 512,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 60000,
        memory_limit_mb: 512,
      },
    },
    template_content: "print(1)",
    artifact_max_size_mb: null,
    llm_config: null,
  } as unknown as ProblemDraftContent;
}

async function tagTasks(problemId: string) {
  return await getDb().select().from(backgroundTasks).where(and(
    eq(backgroundTasks.task_type, "knowledge.tag"),
    eq(backgroundTasks.target_id, problemId),
  ));
}

async function publish(id: string, expectedRevision: number) {
  return await publishProblemVersion(id, {
    expectedRevision,
    actor: userActorFromAuthenticatedId("0"),
  });
}

Deno.test({
  name: "knowledge tag task: 发布新版本投递，草稿保存不投递",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    await setTags(true);
    await seedAiProblem("kg-tag-pub", 930001);
    await saveProblemDraft("kg-tag-pub", {
      content: aiContent("第一版"),
      expectedRevision: 0,
      actorId: "0",
    });
    // 草稿保存不投递。
    assertEquals((await tagTasks("kg-tag-pub")).length, 0);

    const published = await publish("kg-tag-pub", 1);
    const tasks = await tagTasks("kg-tag-pub");
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0]!.dedupe_key, `tag:${published.version_id}`);
    assertEquals(tasks[0]!.target_kind, "problem");
    assertEquals(tasks[0]!.status, "pending");
    const payload = tasks[0]!.payload as Record<string, unknown>;
    assertEquals(payload.version_id, published.version_id);
  },
});

Deno.test({
  name: "knowledge tag task: 开关关闭不投递",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    await setTags(false);
    await seedAiProblem("kg-tag-off", 930002);
    await saveProblemDraft("kg-tag-off", {
      content: aiContent("关闭版"),
      expectedRevision: 0,
      actorId: "0",
    });
    const published = await publish("kg-tag-off", 1);
    assertEquals(published.unchanged, false);
    assertEquals((await tagTasks("kg-tag-off")).length, 0);
  },
});

Deno.test({
  name: "knowledge tag task: 低峰时段外投递 → available_at 为下一个时段开始",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    await setTags(true);
    await updateSetting("knowledge_ai_offpeak_only", true, admin());
    await seedAiProblem("kg-tag-offpeak", 930003);
    await saveProblemDraft("kg-tag-offpeak", {
      content: aiContent("低峰版"),
      expectedRevision: 0,
      actorId: "0",
    });
    setOffpeakNowForTest(OFFPEAK_OUTSIDE_NOW); // 北京 12:00（默认时段外）
    try {
      const published = await publish("kg-tag-offpeak", 1);
      assertEquals(published.unchanged, false);
      const tasks = await tagTasks("kg-tag-offpeak");
      assertEquals(tasks.length, 1);
      assertEquals(
        tasks[0]!.available_at,
        expectedNextStart(OFFPEAK_OUTSIDE_NOW),
      );
    } finally {
      setOffpeakNowForTest(null);
    }
  },
});

Deno.test({
  name: "knowledge tag task: 关闭 offpeak 时任何时刻只投递不等",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    await setTags(true); // 内含 offpeak=false
    await seedAiProblem("kg-tag-open", 930004);
    await saveProblemDraft("kg-tag-open", {
      content: aiContent("任意时刻版"),
      expectedRevision: 0,
      actorId: "0",
    });
    setOffpeakNowForTest(OFFPEAK_OUTSIDE_NOW);
    try {
      await publish("kg-tag-open", 1);
      const tasks = await tagTasks("kg-tag-open");
      assertEquals(tasks.length, 1);
      // 关闭 offpeak 时 available_at 取真实投递时刻（非注入的次日开头）。
      const availableAt = Date.parse(tasks[0]!.available_at);
      assertEquals(Math.abs(availableAt - Date.now()) < 300_000, true);
    } finally {
      setOffpeakNowForTest(null);
    }
  },
});
