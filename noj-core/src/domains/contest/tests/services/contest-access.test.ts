import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  domainMemberRoles,
  domainMemberships,
  domains,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import {
  addDomainMember,
  createDomain,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../workspace/index.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  addParticipants,
  createContest,
  deleteContest,
  verifyContestAccess,
} from "../../index.ts";
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
  await ensureDefaultWorkspace();
  await addDomainMember(getDb(), DEFAULT_DOMAIN_ID, id);
  return id;
}

async function createProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `竞赛访问测试题 ${number}`,
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

async function createContestWithStatus(
  startOffsetMs: number,
  endOffsetMs: number,
  problemId: string,
  creatorId: string,
): Promise<string> {
  const member = await addDomainMember(getDb(), DEFAULT_DOMAIN_ID, creatorId);
  await getDb().insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "editor",
  }).onConflictDoNothing();
  const contest = await createContest({
    title: `竞赛访问测试 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    start_time: new Date(Date.now() + startOffsetMs).toISOString(),
    end_time: new Date(Date.now() + endOffsetMs).toISOString(),
    type: "kaggle",
    password: "InvitePass123",
    problems: [{
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
    }],
  }, creatorId);
  return contest.id;
}

Deno.test({
  name: "contest-access: 默认入口固定main，显式学校域访问及离域撤权",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const creator = await createUser("school-organizer");
    const student = await createUser("school-student");
    const problem = await createProblem(920010);
    await updateSetting("domain_creation_policy", "open", "0");
    const school = await createDomain({
      slug: "organizer-school",
      name: "学校比赛",
      preset: "education",
    }, creator);
    const member = await addDomainMember(getDb(), school.id, student);
    const contest = await createContestWithStatus(
      -10000,
      3600000,
      problem,
      creator,
    );
    await getDb().update(contests).set({ domain_id: school.id }).where(
      eq(contests.id, contest),
    );
    await addParticipants(contest, [student]);
    assertEquals(
      (await verifyContestAccess(student, contest, problem)).allowed,
      false,
    );
    assertEquals(
      (await verifyContestAccess(student, contest, problem, {
        domainId: school.id,
      })).allowed,
      true,
    );
    await getDb().update(domainMemberships).set({
      status: "removed",
      left_at: new Date().toISOString(),
    }).where(eq(domainMemberships.id, member.id));
    assertEquals(
      (await verifyContestAccess(student, contest, problem, {
        domainId: school.id,
      })).allowed,
      false,
    );
  },
});

Deno.test({
  name:
    "contest-access: main及NULL历史都按当前角色授权，创建者撤销管理权限立即失效",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const creator = await createUser("current-main-organizer"),
      problem = await createProblem(920009);
    const contest = await createContestWithStatus(
      -10000,
      3600000,
      problem,
      creator,
    );
    await addParticipants(contest, [creator]);
    for (const storedDomain of [DEFAULT_DOMAIN_ID, null]) {
      await getDb().update(contests).set({ domain_id: storedDomain }).where(
        eq(contests.id, contest),
      );
      const before = await verifyContestAccess(creator, contest, problem);
      assertEquals(before.organizer, true);
      assertEquals(before.allowed, true);
      const member = await addDomainMember(getDb(), DEFAULT_DOMAIN_ID, creator);
      await getDb().delete(domainMemberRoles).where(
        eq(domainMemberRoles.membership_id, member.id),
      );
      await getDb().insert(domainMemberRoles).values({
        membership_id: member.id,
        role: "member",
      });
      const revoked = await verifyContestAccess(creator, contest, problem);
      assertEquals(revoked.organizer, false);
      assertEquals(revoked.allowed, true);
      await getDb().insert(domainMemberRoles).values({
        membership_id: member.id,
        role: "editor",
      });
    }
    const [main] = await getDb().select().from(domains).where(
      eq(domains.id, DEFAULT_DOMAIN_ID),
    );
    await getDb().update(domains).set({
      configuration: { ...main.configuration, access: "members" },
    }).where(eq(domains.id, main.id));
    assertEquals(
      (await verifyContestAccess(null, contest, problem)).allowed,
      false,
    );
  },
});

Deno.test({
  name: "contest-access: running + 参赛者 → allowed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-1");
    const participantId = await createUser("ca-participant-1");
    const problemId = await createProblem(920001);
    const contestId = await createContestWithStatus(
      -60_000,
      60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, true);
      assertEquals(info.running, true);
      assertEquals(info.contestId, contestId);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, participantId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: ended + 参赛者 → allowed（复盘）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-2");
    const participantId = await createUser("ca-participant-2");
    const problemId = await createProblem(920002);
    const contestId = await createContestWithStatus(
      -120_000,
      -60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, true);
      assertEquals(info.running, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, participantId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: 赛前 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-3");
    const participantId = await createUser("ca-participant-3");
    const problemId = await createProblem(920003);
    const contestId = await createContestWithStatus(
      60_000,
      120_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, false);
      assertEquals(info.running, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, participantId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: 非参赛者 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-4");
    const participantId = await createUser("ca-participant-4");
    const strangerId = await createUser("ca-stranger-4");
    const problemId = await createProblem(920004);
    const contestId = await createContestWithStatus(
      -60_000,
      60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        strangerId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, strangerId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, participantId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, creatorId));
    }
  },
});
