import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  buildCommunityPostEntry,
  upsertSearchEntry,
} from "../../services/index-writer.ts";
import { searchFlat } from "../../services/search.ts";
import { createPost } from "../../../community/index.ts";
import { createContest } from "../../../contest/index.ts";
import {
  _resetSystemSettingsForTest,
  ensureRbacSeeds,
  enterTestContext,
  initSystemSettings,
  leaveTestContext,
  updateSetting,
} from "../../../system/index.ts";

const ownerId = "sg-owner";
const problemId = "sg-problem";

async function setup(): Promise<string> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id: ownerId,
    username: ownerId,
    email: `${ownerId}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(problems).values({
    id: problemId,
    title: "搜索门控题",
    description: "x",
    difficulty: "easy",
    runtime_config: {},
    number: 980001,
    type: "U",
    visibility: "public",
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
  return now;
}

Deno.test({
  name: "search gating: 赛期搜不到竞赛题题解，赛后能搜到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 以审核员身份发布（绕过发布门槛）
    const post = await createPost(ownerId, {
      type: "solution",
      title: "搜索门控题解",
      content: "独特关键词 ZZYZX",
      problem_id: problemId,
    }, true);
    await upsertSearchEntry((await buildCommunityPostEntry(post.id))!);

    const contest = await createContest(
      {
        title: `搜索门控 ${Date.now()}`,
        start_time: new Date(Date.now() - 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
        type: "kaggle",
        problems: [{
          problem_id: problemId,
          label: "A",
          sort_order: 0,
          score: 10000,
        }],
      },
      ownerId,
      true,
    );

    const ctx = { isAdmin: false, guestReadEnabled: true };

    // 赛期：普通用户搜不到
    const during = await searchFlat({ q: "ZZYZX", page: 1, perPage: 20, ctx });
    assertEquals(during.items.length, 0);

    // 管理员不受限（复核需要）
    const asAdmin = await searchFlat({
      q: "ZZYZX",
      page: 1,
      perPage: 20,
      ctx: { isAdmin: true, guestReadEnabled: true },
    });
    assertEquals(asAdmin.items.length, 1);

    // 赛后：普通用户恢复可见
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(contests.id, contest.id));
    const after = await searchFlat({ q: "ZZYZX", page: 1, perPage: 20, ctx });
    assertEquals(after.items.length, 1);
  },
});

Deno.test({
  name: "search gating: 非竞赛题的题解任何时刻都可搜到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await createPost(ownerId, {
      type: "solution",
      title: "普通题解",
      content: "独特关键词 QWQER",
      problem_id: problemId,
    }, true);
    await upsertSearchEntry((await buildCommunityPostEntry(post.id))!);

    // 该题不在任何竞赛中
    const result = await searchFlat({
      q: "QWQER",
      page: 1,
      perPage: 20,
      ctx: { isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(result.items.length, 1);
  },
});
