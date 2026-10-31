import { createApp } from "../../../../app.ts";
import { signToken } from "../../../access/identity/index.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  accountNotifications,
  contests,
  domains,
  problems,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createClarification,
  listClarifications,
  replyToClarification,
} from "../../index.ts";
import { createContest, registerForContest } from "../../index.ts";
import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";

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
    domain_id: DEFAULT_DOMAIN_ID,
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
    created_at: now,
    updated_at: now,
  });
  // 竞赛只能固定已发布版本（Handbook §2.6）：夹具题目补迁移基线
  await publishBaselineVersionForTest(id);
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
  const rows = await getDb().select({ id: accountNotifications.id }).from(
    accountNotifications,
  ).where(
    eq(accountNotifications.recipient_id, recipientId),
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
    // VULN-01：提问创建时**默认私密**，必须由主办方显式公开才对外可见
    assertEquals(withProblem.is_public, false);
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
    const [notification] = await getDb().select().from(accountNotifications)
      .where(
        eq(accountNotifications.recipient_id, participantId),
      );
    assertEquals(notification.domain_id, DEFAULT_DOMAIN_ID);
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

Deno.test({
  name: "contest-clarifications: VULN-01 提问默认私密，主办方公开后才广播",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminId = await createUser("clar-v1-admin");
    await makeAdmin(adminId);
    const creatorId = await createUser("clar-v1-creator");
    const askerId = await createUser("clar-v1-asker");
    const otherParticipantId = await createUser("clar-v1-other");
    const problemA = await createProblem(920006);
    const contestId = await createContestWithWindow(creatorId, [problemA]);
    await registerForContest(contestId, askerId);
    await registerForContest(contestId, otherParticipantId);

    // 选手提问（内容含解法思路）——修复前会对全场实时可见
    const question = await createClarification(contestId, askerId, {
      content: "B 题用状态压缩 DP，dp[mask] 表示…（含解法，不应广播）",
      problem_id: problemA,
    });
    assertEquals(question.is_public, false);

    // 匿名 / 其他参赛者均看不到这条未公开的提问
    assertEquals((await listClarifications(contestId, undefined)).total, 0);
    assertEquals(
      (await listClarifications(contestId, otherParticipantId)).total,
      0,
    );
    // 提问者本人与主办方可见
    assertEquals((await listClarifications(contestId, askerId)).total, 1);
    assertEquals((await listClarifications(contestId, creatorId)).total, 1);

    // 主办方以"公告广播"方式公开答复 → 根提问与答复一并转为全员可见
    await replyToClarification(contestId, question.id, adminId, {
      content: "题意澄清：B 题数据范围已修正。",
      is_public: true,
    });
    const anonymous = await listClarifications(contestId, undefined);
    assertEquals(anonymous.total, 1);
    assertEquals(anonymous.data[0].is_public, true);
    assertEquals(anonymous.data[0].replies.length, 1);
    assertEquals(anonymous.data[0].replies[0].is_public, true);
  },
});

Deno.test({
  name: "统一通知：社区关闭仍可读取竞赛答疑，源竞赛删除后隐藏并拒绝已读",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("clar-inbox-creator");
    const student = await createUser("clar-inbox-student");
    const problem = await createProblem(920010);
    const contestId = await createContestWithWindow(creator, [problem]);
    await registerForContest(contestId, student);
    const question = await createClarification(contestId, student, {
      content: "测试答疑",
    });
    await replyToClarification(contestId, question.id, creator, {
      content: "私密答复",
      is_public: false,
    });
    const db = getDb(), app = createApp();
    const token = await signToken({ sub: student, role: "user" });
    const [domain] = await db.select().from(domains).where(
      eq(domains.id, DEFAULT_DOMAIN_ID),
    );
    try {
      await db.update(domains).set({
        configuration: {
          ...domain.configuration,
          features: { ...domain.configuration.features, community: false },
        },
      }).where(eq(domains.id, DEFAULT_DOMAIN_ID));
      const response = await jsonRequest(app, "/api/v1/notifications", {
        token,
      });
      assertEquals(response.status, 200);
      const inbox = await response.json();
      assertEquals(inbox.total, 1);
      assertEquals(inbox.unread_count, 1);
      const path = `/api/v1/notifications/${inbox.data[0].notification.id}`;
      assertEquals((await jsonRequest(app, path, { token })).status, 200);
      await db.delete(contests).where(eq(contests.id, contestId));
      assertEquals(
        (await (await jsonRequest(app, "/api/v1/notifications", { token }))
          .json()).unread_count,
        0,
      );
      assertEquals((await jsonRequest(app, path, { token })).status, 404);
      assertEquals(
        (await jsonRequest(app, `${path}/read`, { token, method: "POST" }))
          .status,
        404,
      );
    } finally {
      await db.update(domains).set({ configuration: domain.configuration })
        .where(eq(domains.id, DEFAULT_DOMAIN_ID));
    }
  },
});

Deno.test({
  name: "统一通知：非参赛者读不到私密答疑，公开回复对同域成员可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("clar-scope-creator");
    const asker = await createUser("clar-scope-asker");
    const outsider = await createUser("clar-scope-outsider");
    const problem = await createProblem(920011);
    const contestId = await createContestWithWindow(creator, [problem]);
    await registerForContest(contestId, asker);
    // 通知在**回复时**创建（不是提问时），因此先落一条私密回复。
    const question = await createClarification(contestId, asker, {
      content: "私密提问",
    });
    await replyToClarification(contestId, question.id, creator, {
      content: "私密答复",
      is_public: false,
    });

    const db = getDb(), app = createApp();
    const askerToken = await signToken({ sub: asker, role: "user" });
    const outsiderToken = await signToken({ sub: outsider, role: "user" });

    /**
     * 每条回复各自生成一条通知，`data.clarification_id` 指向**该条回复**。
     * 这里改写收件人，验证可见性由**答疑本身的授权**决定，而不是"谁被写进
     * recipient_id 谁就能读"。
     *
     * 必须按 `contest_id` 限定：同文件的其它用例也会留下 clarification 通知，
     * 全局 select 会取到别场竞赛的行，导致断言对着错误记录跑。
     */
    const notifications = async () =>
      await db.select().from(accountNotifications).where(
        and(
          eq(accountNotifications.type, "clarification"),
          sql`${accountNotifications.data}->>'contest_id' = ${contestId}`,
        ),
      );
    /**
     * 只读**这一条**通知：列表接口返回的是整个收件箱总数，不能用来判定单条可见性。
     * 详情接口复用同一授权条件，越权返回 404。
     */
    const canRead = async (userId: string, notificationId: string) => {
      await db.update(accountNotifications).set({ recipient_id: userId })
        .where(eq(accountNotifications.id, notificationId));
      const response = await jsonRequest(
        app,
        `/api/v1/notifications/${notificationId}`,
        { token: userId === outsider ? outsiderToken : askerToken },
      );
      return response.status === 200;
    };

    const [privateReply] = await notifications();
    assert(privateReply !== undefined, "私密回复后应创建 clarification 通知");
    try {
      // 线程仍是私密：非参赛者读不到，提问者本人读得到。
      assertEquals(await canRead(outsider, privateReply.id), false);
      assertEquals(await canRead(asker, privateReply.id), true);

      /**
       * 公开回复 = 公告广播：把**根提问**一并转为公开，使全场能看到"问题 + 官方答复"
       * （VULN-01 的既定口径）。通知指向根提问，因此整条线程的可见性随之提升——
       * 之前那条私密回复的通知也变得可读。这不是授权漏洞，而是"公开即公告"的必然
       * 后果：主办方一旦公开，整条线程就是公开的。
       */
      await replyToClarification(contestId, question.id, creator, {
        content: "公开答复",
        is_public: true,
      });
      const [publicReply] = (await notifications()).filter((row) =>
        row.id !== privateReply.id
      );
      assert(publicReply !== undefined, "公开回复应再创建一条通知");
      assertEquals(await canRead(outsider, publicReply.id), true);
      assertEquals(await canRead(outsider, privateReply.id), true);
    } finally {
      await db.update(accountNotifications).set({
        recipient_id: privateReply.recipient_id,
      }).where(eq(accountNotifications.id, privateReply.id));
    }
  },
});
