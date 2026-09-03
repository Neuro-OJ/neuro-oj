import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  communityNotifications,
  contests,
  problems,
  userRoles,
  users,
} from "../../src/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../src/shared/base/errors.ts";
import {
  createClarification,
  listClarifications,
  replyToClarification,
} from "../../src/domains/contest/index.ts";
import {
  createContest,
  registerForContest,
} from "../../src/domains/contest/index.ts";

await resetDbForTest();

async function createUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
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

async function createProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `竞赛答疑测试题 ${number}`,
    description: "测试题面",
    difficulty: "easy",
    runtime_config: {
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
    },
    number,
    owner_id: "0",
    type: "P",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 创建指定时间窗口的竞赛（默认 running），并返回其 id。 */
async function createContestWithWindow(
  creatorId: string,
  problemIds: string[],
  startOffsetMs = -3_600_000,
  endOffsetMs = 3_600_000,
): Promise<string> {
  const contest = await createContest({
    title: "答疑测试竞赛",
    start_time: new Date(Date.now() + startOffsetMs).toISOString(),
    end_time: new Date(Date.now() + endOffsetMs).toISOString(),
    type: "kaggle",
    problems: problemIds.map((problemId, index) => ({
      problem_id: problemId,
      label: String.fromCharCode(65 + index),
      sort_order: index,
      score: 10000,
    })),
  }, creatorId);
  return contest.id;
}

async function makeAdmin(userId: string): Promise<void> {
  await getDb().insert(userRoles).values({
    user_id: userId,
    role_id: "admin",
  });
}

async function countClarificationNotifications(
  recipientId: string,
): Promise<number> {
  const rows = await getDb().select({ id: communityNotifications.id }).from(
    communityNotifications,
  ).where(
    eq(communityNotifications.recipient_id, recipientId),
  );
  return rows.length;
}

Deno.test({
  name: "contest-clarifications: 参赛者提问（时间窗口、题目归属、内容校验）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("clar-creator");
    const participantId = await createUser("clar-participant");
    const outsiderId = await createUser("clar-outsider");
    const problemA = await createProblem(920001);
    const problemB = await createProblem(920002);
    const contestId = await createContestWithWindow(creatorId, [problemA]);
    await registerForContest(contestId, participantId);

    // 挂题目提问成功
    const withProblem = await createClarification(contestId, participantId, {
      content: "样例输入里的第三行是什么意思？",
      problem_id: problemA,
    });
    assertEquals(withProblem.is_public, true);
    assertEquals(withProblem.problem_id, problemA);
    assertEquals(withProblem.problem_label, "A");
    assertEquals(withProblem.replies.length, 0);

    // 全局提问成功
    const globalQuestion = await createClarification(contestId, participantId, {
      content: "罚时规则如何计算？",
    });
    assertEquals(globalQuestion.problem_id, null);
    assertEquals(globalQuestion.problem_label, null);

    // 非参赛者被拒
    await assertRejects(
      () => createClarification(contestId, outsiderId, { content: "能提问吗" }),
      ForbiddenError,
      "仅参赛者可提问",
    );

    // 题目不属于该竞赛被拒
    await assertRejects(
      () =>
        createClarification(contestId, participantId, {
          content: "B 题怎么解",
          problem_id: problemB,
        }),
      BadRequestError,
      "题目不属于该竞赛",
    );

    // 空内容被拒
    await assertRejects(
      () => createClarification(contestId, participantId, { content: "   " }),
      BadRequestError,
      "提问内容不能为空",
    );
  },
});

Deno.test({
  name: "contest-clarifications: 非进行期间不可提问",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("clar-window-creator");
    const participantId = await createUser("clar-window-participant");
    const problemA = await createProblem(920003);
    const pendingId = await createContestWithWindow(
      creatorId,
      [problemA],
      3_600_000,
      7_200_000,
    );
    // ended 竞赛无法注册（registerForContest 拒绝），先以 running 窗口注册，再改为已结束
    const endedId = await createContestWithWindow(creatorId, [problemA]);
    await registerForContest(pendingId, participantId);
    await registerForContest(endedId, participantId);
    await getDb().update(contests).set({
      start_time: new Date(Date.now() - 7_200_000).toISOString(),
      end_time: new Date(Date.now() - 3_600_000).toISOString(),
    }).where(eq(contests.id, endedId));

    await assertRejects(
      () =>
        createClarification(pendingId, participantId, { content: "赛前问" }),
      ForbiddenError,
      "仅可在竞赛进行期间提问",
    );
    await assertRejects(
      () => createClarification(endedId, participantId, { content: "赛后问" }),
      ForbiddenError,
      "仅可在竞赛进行期间提问",
    );
  },
});

Deno.test({
  name: "contest-clarifications: 主办方回复（权限、目标校验、通知）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminId = await createUser("clar-admin");
    await makeAdmin(adminId);
    const creatorId = await createUser("clar-reply-creator");
    const participantId = await createUser("clar-reply-participant");
    const otherParticipantId = await createUser("clar-reply-other");
    const problemA = await createProblem(920004);
    const contestId = await createContestWithWindow(creatorId, [problemA]);
    await registerForContest(contestId, participantId);
    await registerForContest(contestId, otherParticipantId);
    // 创建者提问场景：创建者本身也注册参赛
    await registerForContest(contestId, creatorId);

    const question = await createClarification(contestId, participantId, {
      content: "内存限制是多少？",
      problem_id: problemA,
    });

    // admin 公开回复 → 提问者收到 notification
    const publicReply = await replyToClarification(
      contestId,
      question.id,
      adminId,
      { content: "512MB。", is_public: true },
    );
    assertEquals(publicReply.is_public, true);
    assertEquals(
      await countClarificationNotifications(participantId),
      1,
    );

    // 竞赛创建者（非 admin）私密回复
    const privateReply = await replyToClarification(
      contestId,
      question.id,
      creatorId,
      { content: "注意初始化。", is_public: false },
    );
    assertEquals(privateReply.is_public, false);

    // 普通参赛者（非主办方）回复被拒
    await assertRejects(
      () =>
        replyToClarification(contestId, question.id, otherParticipantId, {
          content: "我也补充一句",
          is_public: true,
        }),
      ForbiddenError,
      "仅管理员或竞赛创建者可回复",
    );

    // 回复不存在的提问
    await assertRejects(
      () =>
        replyToClarification(contestId, crypto.randomUUID(), adminId, {
          content: "x",
          is_public: true,
        }),
      NotFoundError,
      "提问不存在",
    );

    // 回复的回复被拒
    await assertRejects(
      () =>
        replyToClarification(contestId, publicReply.id, adminId, {
          content: "再回复一层",
          is_public: true,
        }),
      BadRequestError,
      "仅可回复提问本身",
    );

    // is_public 缺失被拒
    await assertRejects(
      () =>
        replyToClarification(contestId, question.id, adminId, {
          content: "缺 is_public",
        }),
      BadRequestError,
      "is_public 必须为布尔值",
    );

    // 自己回复自己不产生通知
    const selfQuestion = await createClarification(contestId, creatorId, {
      content: "创建者自己提问",
    });
    await replyToClarification(contestId, selfQuestion.id, creatorId, {
      content: "自己回复",
      is_public: true,
    });
    assertEquals(await countClarificationNotifications(creatorId), 0);
  },
});

Deno.test({
  name: "contest-clarifications: 列表可见性（匿名/未参赛/参赛者/主办方）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminId = await createUser("clar-list-admin");
    await makeAdmin(adminId);
    const creatorId = await createUser("clar-list-creator");
    const askerId = await createUser("clar-list-asker");
    const otherParticipantId = await createUser("clar-list-other");
    const problemA = await createProblem(920005);
    const contestId = await createContestWithWindow(creatorId, [problemA]);
    await registerForContest(contestId, askerId);
    await registerForContest(contestId, otherParticipantId);

    const question = await createClarification(contestId, askerId, {
      content: "公开提问",
      problem_id: problemA,
    });
    await replyToClarification(contestId, question.id, adminId, {
      content: "公开回复",
      is_public: true,
    });
    await replyToClarification(contestId, question.id, adminId, {
      content: "私密回复",
      is_public: false,
    });

    // 匿名：仅公开问答
    const anonymous = await listClarifications(contestId, undefined);
    assertEquals(anonymous.total, 1);
    assertEquals(anonymous.data[0].replies.length, 1);
    assertEquals(anonymous.data[0].replies[0].content, "公开回复");

    // 未参赛用户：同匿名
    const outsiderId = await createUser("clar-list-outsider");
    const outsider = await listClarifications(contestId, outsiderId);
    assertEquals(outsider.total, 1);
    assertEquals(outsider.data[0].replies.length, 1);

    // 提问者：能看到自己的私密回复
    const asker = await listClarifications(contestId, askerId);
    assertEquals(asker.total, 1);
    assertEquals(asker.data[0].replies.length, 2);
    assertEquals(
      asker.data[0].replies.some((reply) => reply.content === "私密回复"),
      true,
    );

    // 其他参赛者：看不到提问者的私密回复
    const other = await listClarifications(contestId, otherParticipantId);
    assertEquals(other.total, 1);
    assertEquals(other.data[0].replies.length, 1);
    assertEquals(
      other.data[0].replies.some((reply) => reply.content === "私密回复"),
      false,
    );

    // 主办方：全部可见
    const admin = await listClarifications(contestId, adminId);
    assertEquals(admin.total, 1);
    assertEquals(admin.data[0].replies.length, 2);

    // 创建者（非 admin）：全部可见
    const creator = await listClarifications(contestId, creatorId);
    assertEquals(creator.data[0].replies.length, 2);

    // 分页参数校验
    await assertRejects(
      () => listClarifications(contestId, undefined, { page: 0 }),
      BadRequestError,
      "page 必须为正整数",
    );
    await assertRejects(
      () => listClarifications(contestId, undefined, { perPage: 1000 }),
      BadRequestError,
    );
  },
});
