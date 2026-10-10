/**
 * 竞赛题目固定版本测试（Handbook §4.1/§4.3）。
 *
 * 规则：
 * - 创建竞赛时把每道题钉在**当时的**已发布最新版（`contest_problems.pinned_version_id`）；
 * - 题库之后发布新版本**不影响**已固定版本（换版必须走显式的固定版本升级操作）；
 * - 编辑竞赛会整体替换题目关联，但必须保留既有固定版本（否则改名/改时间等于静默换版）；
 * - 新加入竞赛的题目按当前最新已发布版固定；题库尚无已发布版本的题目固定为 null（存量路径）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  problems,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createContest,
  getContestProblems,
  updateContest,
} from "../../index.ts";

await resetDbForTest();

const now = new Date().toISOString();

async function createUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 建一道带 AI 版本内容的题（visibility 默认 public，任何登录用户可加入竞赛）。 */
async function createProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: id,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    created_at: now,
    updated_at: now,
  });
}

/** 为题目发布一个版本并推进 `problems.latest_version_id`。 */
async function publishVersion(
  problemId: string,
  version: number,
): Promise<string> {
  const versionId = `${problemId}-v${version}`;
  await getDb().insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version,
    schema_version: 1,
    origin: "published",
    content: {
      kind: "ai",
      title: problemId,
      description: "d",
      samples: [],
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
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    content_sha256: `hash-${versionId}`,
    published_at: now,
  });
  await getDb().update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  return versionId;
}

async function pinnedVersionOf(
  contestId: string,
  problemId: string,
): Promise<string | null> {
  const [row] = await getDb().select({
    pinned_version_id: contestProblems.pinned_version_id,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  ).limit(1);
  return row?.pinned_version_id ?? null;
}

Deno.test({
  name: "contest pinning: 创建即固定最新版，题库发新版不改变竞赛作答版本",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pinning-creator");
    await createProblem("cp-pin-p1", 985001);
    await createProblem("cp-pin-p2", 985002);
    await publishVersion("cp-pin-p1", 1);
    const p1v2 = await publishVersion("cp-pin-p1", 2);
    // p2 尚未发布任何版本 → 固定为 null（迁移期存量路径）

    const contest = await createContest({
      title: "固定版本测试赛",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      password: "ContestPass123",
      problems: [
        { problem_id: "cp-pin-p1", label: "A", sort_order: 0, score: 10000 },
        { problem_id: "cp-pin-p2", label: "B", sort_order: 1, score: 10000 },
      ],
    }, creatorId);

    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p1"), p1v2);
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p2"), null);

    // 题库发布 v3：竞赛固定版本不变，竞赛接口仍回答 v2
    await publishVersion("cp-pin-p1", 3);
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p1"), p1v2);
    const problemsInContest = await getContestProblems(contest.id, creatorId);
    const itemA = problemsInContest.find((item) =>
      item.problem_id === "cp-pin-p1"
    );
    assertEquals(itemA?.version_id, p1v2);
    assertEquals(itemA?.version, 2);
    const itemB = problemsInContest.find((item) =>
      item.problem_id === "cp-pin-p2"
    );
    assertEquals(itemB?.version_id, null);
    assertEquals(itemB?.version, null);
  },
});

Deno.test({
  name:
    "contest pinning: 编辑竞赛整体替换题目关联但保留固定版本，新题按当前最新版固定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pinning-editor");
    await createProblem("cp-pin-p3", 985003);
    await createProblem("cp-pin-p4", 985004);
    await publishVersion("cp-pin-p3", 1);
    const p3v2 = await publishVersion("cp-pin-p3", 2);

    const contest = await createContest({
      title: "编辑保留固定版本",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      password: "ContestPass123",
      problems: [
        { problem_id: "cp-pin-p3", label: "A", sort_order: 0, score: 10000 },
      ],
    }, creatorId);
    // 创建时钉在 v2（当时的最新版）
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p3"), p3v2);

    // 题库再发 v3，之后编辑竞赛（改名 + 重传同一题目列表）：固定版本必须仍是创建时的 v2
    await publishVersion("cp-pin-p3", 3);
    await updateContest(contest.id, {
      title: "改名后仍固定 v2",
      problems: [
        { problem_id: "cp-pin-p3", label: "A", sort_order: 0, score: 10000 },
        { problem_id: "cp-pin-p4", label: "B", sort_order: 1, score: 10000 },
      ],
    });
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p3"), p3v2);
    // 新加入的 cp-pin-p4 尚无版本 → null；先发版本再加题则按当时最新版固定
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p4"), null);
    await publishVersion("cp-pin-p4", 1);
    await updateContest(contest.id, {
      problems: [
        { problem_id: "cp-pin-p3", label: "A", sort_order: 0, score: 10000 },
        { problem_id: "cp-pin-p4", label: "B", sort_order: 1, score: 10000 },
      ],
    });
    assertEquals(
      await pinnedVersionOf(contest.id, "cp-pin-p4"),
      "cp-pin-p4-v1",
    );
    // 再次整体替换后，p3 仍停在创建时的 v2（不会被抬到 v3）
    assertEquals(await pinnedVersionOf(contest.id, "cp-pin-p3"), p3v2);
    const problemsInContest = await getContestProblems(contest.id, creatorId);
    assertEquals(
      problemsInContest.find((item) => item.problem_id === "cp-pin-p3")
        ?.version,
      2,
    );
  },
});
