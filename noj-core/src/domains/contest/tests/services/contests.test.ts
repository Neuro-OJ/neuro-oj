import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  addParticipants,
  computeContestStatus,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  listParticipants,
  registerForContest,
  removeParticipant,
  resolveContestId,
  updateContest,
} from "../../index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";

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
    title: `竞赛服务测试题 ${number}`,
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
    type: "U",
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "contests service: CRUD、密码注册与参与者边界",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("contest-creator");
    const participantId = await createUser("contest-participant");
    const invitedId = await createUser("contest-invited");
    const problemA = await createProblem(910001);
    const problemB = await createProblem(910002);
    const startTime = new Date(Date.now() + 60_000).toISOString();
    const endTime = new Date(Date.now() + 3_600_000).toISOString();

    const contest = await createContest({
      title: "测试 Kaggle 竞赛",
      start_time: startTime,
      end_time: endTime,
      type: "kaggle",
      password: "ContestPass123",
      problems: [{
        problem_id: problemA,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creatorId);

    try {
      assertEquals(contest.status, "pending");
      assertEquals(contest.kind, "invite");
      assertEquals(contest.is_public, false);
      assertEquals(contest.problem_count, 1);
      assertEquals(contest.has_password, true);
      assertMatch(
        contest.public_id,
        /^ct-[123456789abcdefghjkmnpqrstuvwxyz]{8}$/,
      );
      assertEquals(await resolveContestId(contest.public_id), contest.id);
      assertEquals(await resolveContestId(contest.id), contest.id);
      assertEquals(computeContestStatus(startTime, endTime), "pending");

      // invite 赛不进入公开列表（I4）
      const listed = await listContests({ page: 1, perPage: 20 });
      assertEquals(listed.data.some((item) => item.id === contest.id), false);

      await assertRejects(
        () => registerForContest(contest.id, participantId, "wrong"),
        ForbiddenError,
        "邀请码错误",
      );
      await registerForContest(contest.id, participantId, "ContestPass123");
      assertEquals(await isParticipant(contest.id, participantId), true);
      await assertRejects(
        () => registerForContest(contest.id, participantId, "ContestPass123"),
        ConflictError,
        "已注册该竞赛",
      );

      assertEquals(
        await addParticipants(contest.id, [invitedId, invitedId]),
        1,
      );
      assertEquals((await listParticipants(contest.id)).length, 2);
      await removeParticipant(contest.id, invitedId);
      assertEquals(await isParticipant(contest.id, invitedId), false);

      // invite 赛清空邀请码必须被拒绝（评审 #2）：注册侧对 invite 恒走邀请码校验，
      // 库中无凭据即赛事不可加入。此处原断言 has_password=false，编码的正是该缺陷，
      // 与 security.md「invite 创建/更新必须设置邀请码」相悖，故改为拒绝 + 换码。
      await assertRejects(
        () =>
          updateContest(contest.id, {
            title: "清空邀请码",
            password: null,
          }),
        BadRequestError,
        "邀请赛必须设置邀请码",
      );

      const updated = await updateContest(contest.id, {
        title: "已更新竞赛",
        password: "RotatedPass123",
        problems: [
          { problem_id: problemA, label: "A", sort_order: 0, score: 10000 },
          { problem_id: problemB, label: "B", sort_order: 1, score: 10000 },
        ],
      });
      assertEquals(updated.title, "已更新竞赛");
      assertEquals(updated.has_password, true);
      assertEquals(updated.problem_count, 2);
      // 换码后旧码失效、新码可注册（邀请码确实被轮换而非保留）
      await assertRejects(
        () => registerForContest(contest.id, invitedId, "ContestPass123"),
        ForbiddenError,
        "邀请码错误",
      );
      await registerForContest(contest.id, invitedId, "RotatedPass123");
      assertEquals(
        (await getContestProblems(contest.id, participantId)).length,
        2,
      );

      await deleteContest(contest.id);
      await assertRejects(
        () => getContest(contest.id),
        NotFoundError,
        "竞赛不存在",
      );
    } finally {
      await deleteContest(contest.id).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemA));
      await db.delete(problems).where(eq(problems.id, problemB));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, invitedId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contests service: 普通用户把他人 private 题加入竞赛 → Forbidden",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await createUser("add-private-owner");
    const normal = await createUser("add-private-normal");
    const problemId = await createProblem(950001);
    const db = getDb();
    await db.update(problems).set({ visibility: "private" }).where(
      eq(problems.id, problemId),
    );
    try {
      await assertRejects(
        () =>
          createContest({
            title: "套题测试",
            start_time: new Date(Date.now() - 60_000).toISOString(),
            end_time: new Date(Date.now() + 3_600_000).toISOString(),
            type: "kaggle",
            kind: "invite",
            password: "InvitePass123",
            problems: [{
              problem_id: problemId,
              label: "A",
              sort_order: 0,
              score: 10000,
            }],
          }, normal),
        ForbiddenError,
        "仅可加入公开题或自己拥有的题目",
      );
    } finally {
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, normal));
      await db.delete(users).where(eq(users.id, owner));
    }
  },
});

Deno.test({
  name: "contests service: 普通用户创建 invite 未带密码 → BadRequest",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("invite-no-pass");
    const problemId = await createProblem(950002);
    const db = getDb();
    try {
      await assertRejects(
        () =>
          createContest({
            title: "无邀请码竞赛",
            start_time: new Date(Date.now() - 60_000).toISOString(),
            end_time: new Date(Date.now() + 3_600_000).toISOString(),
            type: "kaggle",
            kind: "invite",
            problems: [{
              problem_id: problemId,
              label: "A",
              sort_order: 0,
              score: 10000,
            }],
          }, creator),
        BadRequestError,
        "邀请赛必须设置邀请码",
      );
    } finally {
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});

Deno.test({
  name: "contests service: 普通用户创建 public 赛 → Forbidden",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("public-no-admin");
    const problemId = await createProblem(950003);
    const db = getDb();
    try {
      await assertRejects(
        () =>
          createContest({
            title: "普通用户建公开赛",
            start_time: new Date(Date.now() - 60_000).toISOString(),
            end_time: new Date(Date.now() + 3_600_000).toISOString(),
            type: "kaggle",
            kind: "public",
            password: "PublicPass123",
            problems: [{
              problem_id: problemId,
              label: "A",
              sort_order: 0,
              score: 10000,
            }],
          }, creator),
        ForbiddenError,
        "仅管理员可创建公开赛",
      );
    } finally {
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});

Deno.test({
  name: "contests service: public 赛无邀请码自助注册成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = await createUser("public-admin");
    const participant = await createUser("public-participant");
    const problemId = await createProblem(950004);
    const db = getDb();
    const contest = await createContest(
      {
        title: "公开自助赛",
        start_time: new Date(Date.now() - 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
        type: "kaggle",
        kind: "public",
        problems: [{
          problem_id: problemId,
          label: "A",
          sort_order: 0,
          score: 10000,
        }],
      },
      admin,
      true,
    );
    try {
      assertEquals(contest.kind, "public");
      assertEquals(contest.is_public, true);
      await registerForContest(contest.id, participant);
      assertEquals(await isParticipant(contest.id, participant), true);
    } finally {
      await deleteContest(contest.id).catch(() => {});
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participant));
      await db.delete(users).where(eq(users.id, admin));
    }
  },
});

Deno.test({
  name: "contests service: invite 赛无邀请码注册 → Forbidden",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("invite-strict");
    const participant = await createUser("invite-user");
    const problemId = await createProblem(950005);
    const db = getDb();
    const contest = await createContest({
      title: "严格邀请赛",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      kind: "invite",
      password: "SecretCode123",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creator);
    try {
      await assertRejects(
        () => registerForContest(contest.id, participant),
        ForbiddenError,
        "邀请码错误",
      );
    } finally {
      await deleteContest(contest.id).catch(() => {});
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participant));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});

Deno.test({
  name: "contests service: 历史明文邀请码兼容注册（C3）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("legacy-invite-owner");
    const participant = await createUser("legacy-invite-user");
    const problemId = await createProblem(950006);
    const db = getDb();
    const contest = await createContest({
      title: "历史明文邀请赛",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      kind: "invite",
      password: "HashedCode123",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creator);
    // 模拟 0064 迁移早期曾回填明文邀请码的存量数据
    await db.update(contests).set({ password: "legacy-plain-code" })
      .where(eq(contests.id, contest.id));
    try {
      await registerForContest(contest.id, participant, "legacy-plain-code");
      assertEquals(await isParticipant(contest.id, participant), true);
    } finally {
      await deleteContest(contest.id).catch(() => {});
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participant));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});

/**
 * 评审 #2 回归：public → invite 的更新可生成"无密码邀请赛"。
 *
 * 原实现只在"请求里显式传了 password === null"时拒绝。公开赛存量 password 为 null 时，
 * 请求仅传 `kind=invite`（不带 password）会得到
 * `kind=invite / is_public=false / password=null`——注册侧对 invite 恒走邀请码校验，
 * 而库中无任何可匹配凭据，赛事从此**不可加入**。
 */
Deno.test({
  name:
    "contests service(评审#2): public 转 invite 未带密码 → BadRequest，不产生无密码邀请赛",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("kind-invite-owner");
    const problemId = await createProblem(950007);
    const db = getDb();
    // 不传 password 的默认 createContest：password 落库为 null
    const contest = await createContest(
      {
        title: "公开赛转邀请赛",
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
      creator,
      true,
    );
    try {
      assertEquals(contest.kind, "public");
      assertEquals(contest.has_password, false);

      // 仅改 kind，不带 password：必须在写库前被拒绝
      await assertRejects(
        () => updateContest(contest.id, { kind: "invite" }, true),
        BadRequestError,
        "邀请赛必须设置邀请码",
      );

      // 反证：库中仍是公开赛，未被写成"无密码邀请赛"
      const stored = await db.select({
        kind: contests.kind,
        is_public: contests.is_public,
        password: contests.password,
      }).from(contests).where(eq(contests.id, contest.id));
      assertEquals(stored[0]?.kind, "public");
      assertEquals(stored[0]?.is_public, true);
      assertEquals(stored[0]?.password, null);

      // 带上传入密码即可正常转 invite
      const updated = await updateContest(contest.id, {
        kind: "invite",
        password: "NewInviteCode1",
      }, true);
      assertEquals(updated.kind, "invite");
      assertEquals(updated.is_public, false);
      assertEquals(updated.has_password, true);

      // 反证：转 invite 后必须真的有可用邀请码（否则等于把赛事锁死）
      const participant = await createUser("kind-invite-user");
      await registerForContest(contest.id, participant, "NewInviteCode1");
      assertEquals(await isParticipant(contest.id, participant), true);
      await db.delete(users).where(eq(users.id, participant));
    } finally {
      await deleteContest(contest.id).catch(() => {});
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});

/**
 * 评审 #2 回归（清除路径）：invite 赛显式清空密码同样必须被拒绝。
 *
 * 与上一条互补——上一条是"现值可用、请求未带"，本条是"现值可用、请求显式清空"。
 * 两者都必须收敛到"邀请赛始终有可用凭据"这一不变量。
 */
Deno.test({
  name: "contests service(评审#2): invite 赛清空邀请码 → BadRequest",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("invite-clear-owner");
    const problemId = await createProblem(950008);
    const db = getDb();
    const contest = await createContest(
      {
        title: "清空邀请码测试",
        start_time: new Date(Date.now() - 60_000).toISOString(),
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
        type: "kaggle",
        kind: "invite",
        password: "KeepMeCode123",
        problems: [{
          problem_id: problemId,
          label: "A",
          sort_order: 0,
          score: 10000,
        }],
      },
      creator,
      true,
    );
    try {
      await assertRejects(
        () => updateContest(contest.id, { password: null }, true),
        BadRequestError,
        "邀请赛必须设置邀请码",
      );
      // 反证：原邀请码未被清除，仍可注册
      const participant = await createUser("invite-clear-user");
      await registerForContest(contest.id, participant, "KeepMeCode123");
      assertEquals(await isParticipant(contest.id, participant), true);
      await db.delete(users).where(eq(users.id, participant));
    } finally {
      await deleteContest(contest.id).catch(() => {});
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, creator));
    }
  },
});
