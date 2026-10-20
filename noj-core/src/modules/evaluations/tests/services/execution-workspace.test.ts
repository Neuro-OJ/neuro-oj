import { assertEquals, assertIsError, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainMemberRoles,
  domainProblemBindings,
  domains,
  objectiveSubmissions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createProblem,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../problems/index.ts";
import {
  addDomainMember,
  createDomain,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../../domains/workspace/index.ts";
import { updateSetting } from "../../../../domains/system/index.ts";
import { submitObjectivePaper } from "../../../../domains/objective/index.ts";
import { backfillExecutionWorkspaces } from "../../index.ts";
import { AppError } from "../../../../shared/base/errors.ts";

async function fixture() {
  await resetDbForTest();
  const db = getDb(),
    user = crypto.randomUUID(),
    now = new Date().toISOString();
  await db.insert(users).values({
    id: user,
    username: user,
    email: `${user}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await ensureDefaultWorkspace();
  const member = await addDomainMember(db, DEFAULT_DOMAIN_ID, user);
  await db.insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "editor",
  });
  const first = await createProblem(
    {
      title: "历史套卷",
      description: "卷面",
      is_objective: true,
      visibility: "public",
    },
    user,
    "user",
  );
  const [binding] = await db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, first.id),
  );
  await updateSetting("domain_creation_policy", "open", "0");
  const other = await createDomain({
    slug: "execution-school",
    name: "学校",
    preset: "education",
  }, user);
  return { db, user, now, first, binding, other };
}

/** 仅历史回填用例恢复扩展阶段的列；专用测试数据库不会自动回滚这些 DDL。 */
async function reopenLegacyColumns(db: ReturnType<typeof getDb>) {
  await db.execute(
    sql`ALTER TABLE submissions ALTER COLUMN domain_id DROP NOT NULL, ALTER COLUMN domain_problem_binding_id DROP NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE submission_jobs ALTER COLUMN domain_id DROP NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE submission_job_items ALTER COLUMN domain_id DROP NOT NULL, DROP CONSTRAINT IF EXISTS submission_job_items_binding_required_check`,
  );
}

/** 回填用例必须把临时的扩展阶段 schema 恢复为正式 schema，避免污染后续用例。 */
async function restoreExecutionColumns(db: ReturnType<typeof getDb>) {
  await db.execute(
    sql`ALTER TABLE submissions ALTER COLUMN domain_id SET NOT NULL, ALTER COLUMN domain_problem_binding_id SET NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE submission_jobs ALTER COLUMN domain_id SET NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE submission_job_items ALTER COLUMN domain_id SET NOT NULL`,
  );
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'submission_job_items'::regclass
          AND conname = 'submission_job_items_binding_required_check'
      ) THEN
        ALTER TABLE submission_job_items
          ADD CONSTRAINT submission_job_items_binding_required_check
          CHECK (
            domain_problem_binding_id IS NOT NULL
            OR status IN ('failed', 'skipped')
          );
      END IF;
    END
    $$;
  `));
}

async function withLegacyExecutionColumns<T>(
  db: ReturnType<typeof getDb>,
  fn: () => Promise<T>,
  cleanup?: () => Promise<void>,
): Promise<T> {
  await reopenLegacyColumns(db);
  try {
    return await fn();
  } finally {
    await cleanup?.();
    await restoreExecutionColumns(db);
  }
}

Deno.test("执行归属：源题相同也不能将其他域绑定写入默认域提交", async () => {
  const f = await fixture();
  const shared = crypto.randomUUID();
  await f.db.insert(domainProblemBindings).values({
    id: shared,
    domain_id: f.other.id,
    problem_id: f.first.id,
    kind: "shared",
    created_by: f.user,
    created_at: f.now,
    updated_at: f.now,
  });
  const error = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(submissions).values({
        id: crypto.randomUUID(),
        domain_id: DEFAULT_DOMAIN_ID,
        domain_problem_binding_id: shared,
        user_id: f.user,
        problem_id: f.first.id,
        language: "python3",
        code: "original",
        created_at: f.now,
      })
    )
  );
  assertIsError(error);
  assertEquals((error.cause as { code: string }).code, "23503");
});

Deno.test("执行约束：正式执行与任务必须有域，只有失败或跳过条目允许空绑定", async () => {
  const f = await fixture();
  for (const table of ["submissions", "objective_submissions", "self_tests"]) {
    for (const missing of ["domain_id", "domain_problem_binding_id"]) {
      const domainId = missing === "domain_id" ? null : DEFAULT_DOMAIN_ID;
      const bindingId = missing === "domain_problem_binding_id"
        ? null
        : f.binding.id;
      const error = await assertRejects(() =>
        f.db.transaction(async (tx) => {
          const problemColumn = table === "objective_submissions"
            ? "paper_id"
            : "problem_id";
          const extraColumns = table === "objective_submissions"
            ? sql`submission_type, answers`
            : sql`language, code`;
          const extraValues = table === "objective_submissions"
            ? sql`'practice', '{}'::jsonb`
            : sql`'python3', 'original'`;
          await tx.execute(sql`INSERT INTO ${sql.identifier(table)}
          (id, domain_id, domain_problem_binding_id, user_id, ${
            sql.identifier(problemColumn)
          }, created_at, ${extraColumns})
          VALUES (${crypto.randomUUID()}, ${domainId}, ${bindingId}, ${f.user}, ${f.first.id}, ${f.now}, ${extraValues})`);
        })
      );
      assertIsError(error);
      assertEquals((error.cause as { code: string }).code, "23502");
      const cause = error.cause as { column_name?: string; column?: string };
      assertEquals(cause.column_name ?? cause.column, missing);
    }
  }
  const missingJob = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.execute(
        sql`INSERT INTO submission_jobs (id, actor_id, kind, idempotency_key, request_hash, created_at)
      VALUES (${crypto.randomUUID()}, ${f.user}, 'rejudge', 'missing-domain', 'hash', ${f.now})`,
      )
    )
  );
  assertIsError(missingJob);
  assertEquals((missingJob.cause as { code: string }).code, "23502");
  const jobId = crypto.randomUUID();
  await f.db.insert(submissionJobs).values({
    id: jobId,
    domain_id: DEFAULT_DOMAIN_ID,
    actor_id: f.user,
    kind: "rejudge",
    idempotency_key: "constraint-statuses",
    request_hash: "hash",
    created_at: f.now,
  });
  const missingItem = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.execute(sql`INSERT INTO submission_job_items
      (id, job_id, ordinal, source_kind, source_id, problem_id, status, created_at)
      VALUES (${crypto.randomUUID()}, ${jobId}, 0, 'submission', 'missing-domain', '', 'failed', ${f.now})`)
    )
  );
  assertIsError(missingItem);
  assertEquals((missingItem.cause as { code: string }).code, "23502");
  for (
    const status of [
      "pending",
      "preparing",
      "dispatched",
      "succeeded",
      "failed",
      "skipped",
    ] as const
  ) {
    const insert = () =>
      f.db.transaction((tx) =>
        tx.insert(submissionJobItems).values({
          id: crypto.randomUUID(),
          domain_id: DEFAULT_DOMAIN_ID,
          job_id: jobId,
          ordinal: 0,
          source_kind: "submission",
          source_id: status,
          problem_id: "deleted-source",
          status,
          created_at: f.now,
        })
      );
    if (status === "failed" || status === "skipped") await insert();
    else {
      const error = await assertRejects(insert);
      assertIsError(error);
      assertEquals((error.cause as { code: string }).code, "23514");
      const cause = error.cause as {
        constraint_name?: string;
        constraint?: string;
      };
      assertEquals(
        cause.constraint_name ?? cause.constraint,
        "submission_job_items_binding_required_check",
      );
    }
  }
});

Deno.test("执行归属：任务幂等键包含域，条目不能放入另一域任务", async () => {
  const f = await fixture();
  const jobs = [crypto.randomUUID(), crypto.randomUUID()];
  await f.db.insert(submissionJobs).values(
    jobs.map((id, index) => ({
      id,
      domain_id: index ? f.other.id : DEFAULT_DOMAIN_ID,
      kind: "upgrade" as const,
      actor_id: f.user,
      idempotency_key: "same-key",
      request_hash: "same-hash",
      created_at: f.now,
    })),
  );
  assertEquals((await f.db.select().from(submissionJobs)).length, 2);
  const error = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(submissionJobItems).values({
        id: crypto.randomUUID(),
        job_id: jobs[0],
        domain_id: f.other.id,
        ordinal: 0,
        source_kind: "submission",
        source_id: "historical",
        problem_id: f.first.id,
        status: "failed",
        created_at: f.now,
      })
    )
  );
  assertIsError(error);
  assertEquals((error.cause as { code: string }).code, "23503");
});

Deno.test("执行回填：保留 ID、代码、受理时间及未知版本，重复回填幂等", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await withLegacyExecutionColumns(f.db, async () => {
    await f.db.execute(
      sql`INSERT INTO submissions (id, user_id, problem_id, language, code, created_at)
      VALUES (${id}, ${f.user}, ${f.first.id}, 'python3', 'immutable-code', ${f.now})`,
    );
    // 实际追加 SQL 从扩展状态完成回填与收缩，不能仅证明空库建表。
    const migration = await Deno.readTextFile(
      new URL(
        "../../../../../drizzle/0116_peaceful_gorilla_man.sql",
        import.meta.url,
      ),
    );
    const backfill = migration.split("-- BEGIN EXECUTION WORKSPACE BACKFILL")[1]
      .split("-- END EXECUTION WORKSPACE BACKFILL")[0];
    const contraction = migration.split("--> statement-breakpoint").filter((
      statement,
    ) =>
      /ALTER TABLE "(submissions|objective_submissions|self_tests|submission_jobs|submission_job_items)" ALTER COLUMN "(domain_id|domain_problem_binding_id)" SET NOT NULL/
        .test(statement) ||
      statement.includes(
        'ADD CONSTRAINT "submission_job_items_binding_required_check"',
      )
    );
    for (
      const statement of [
        ...backfill.split("--> statement-breakpoint"),
        ...contraction,
      ]
    ) {
      if (statement.trim()) await f.db.execute(sql.raw(statement));
    }
    await backfillExecutionWorkspaces();
    await backfillExecutionWorkspaces();
    const [row] = await f.db.select().from(submissions).where(
      eq(submissions.id, id),
    );
    assertEquals([
      row.id,
      row.code,
      row.created_at,
      row.version_origin,
      row.submitted_version_id,
    ], [id, "immutable-code", f.now, "legacy_unknown", null]);
    assertEquals(row.domain_id, DEFAULT_DOMAIN_ID);
    assertEquals(row.domain_problem_binding_id, f.binding.id);
  });
});

Deno.test("执行回填：无合法源题的 failed/skipped 条目保留原始引用和空绑定", async () => {
  const f = await fixture(), jobId = crypto.randomUUID();
  await withLegacyExecutionColumns(f.db, async () => {
    await f.db.execute(sql`INSERT INTO submission_jobs
      (id, actor_id, kind, idempotency_key, request_hash, status, created_at)
      VALUES (${jobId}, ${f.user}, 'rejudge', 'terminal-history', 'history', 'completed_with_errors', ${f.now})`);
    for (const [ordinal, status] of ["failed", "skipped"].entries()) {
      await f.db.execute(sql`INSERT INTO submission_job_items
        (id, job_id, ordinal, source_kind, source_id, problem_id, target_version_ref, status, created_at)
        VALUES (${crypto.randomUUID()}, ${jobId}, ${ordinal}, 'submission', ${`deleted-source-${ordinal}`},
          ${
        ordinal ? "" : "deleted-problem-reference"
      }, 'deleted-version-reference', ${status}, ${f.now})`);
    }
    await backfillExecutionWorkspaces();
    const summaries = await backfillExecutionWorkspaces();
    assertEquals(summaries.find((row) => row.kind === "items")?.incomplete, 0);
    const items = await f.db.select().from(submissionJobItems).where(
      eq(submissionJobItems.job_id, jobId),
    ).orderBy(submissionJobItems.ordinal);
    assertEquals(
      items.map((item) => [
        item.domain_id,
        item.domain_problem_binding_id,
        item.problem_id,
        item.status,
        item.target_version_ref,
      ]),
      [
        [
          DEFAULT_DOMAIN_ID,
          null,
          "deleted-problem-reference",
          "failed",
          "deleted-version-reference",
        ],
        [DEFAULT_DOMAIN_ID, null, "", "skipped", "deleted-version-reference"],
      ],
    );
  });
});

Deno.test("执行回填：空题目引用不能让无绑定 pending 条目通过核对，事务回滚", async () => {
  const f = await fixture(), jobId = crypto.randomUUID();
  await withLegacyExecutionColumns(
    f.db,
    async () => {
      await f.db.execute(sql`INSERT INTO submission_jobs
        (id, actor_id, kind, idempotency_key, request_hash, created_at)
        VALUES (${jobId}, ${f.user}, 'rejudge', 'pending-history', 'history', ${f.now})`);
      await f.db.execute(sql`INSERT INTO submission_job_items
        (id, job_id, ordinal, source_kind, source_id, problem_id, status, created_at)
        VALUES (${crypto.randomUUID()}, ${jobId}, 0, 'submission', 'deleted-source', '', 'pending', ${f.now})`);
      const error = await assertRejects(
        () => backfillExecutionWorkspaces(),
        AppError,
      );
      assertEquals(error.code, "EXECUTION_BACKFILL_INCOMPLETE");
      const [job] = await f.db.select().from(submissionJobs).where(
        eq(submissionJobs.id, jobId),
      );
      assertEquals(job.domain_id, null);
    },
    async () => {
      await f.db.delete(submissionJobItems).where(
        eq(submissionJobItems.job_id, jobId),
      );
      await f.db.delete(submissionJobs).where(eq(submissionJobs.id, jobId));
    },
  );
});

Deno.test("执行写入：客观题使用服务端默认域，忽略客户端伪造归属", async () => {
  const f = await fixture();
  await saveProblemDraft(f.first.id, {
    actorId: f.user,
    expectedRevision: 1,
    content: {
      kind: "objective",
      title: "套卷",
      description: "题面",
      samples: [],
      questions: [{
        key: "sum",
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "加法",
      }],
    },
  });
  const published = await publishProblemVersion(f.first.id, {
    expectedRevision: 2,
    actorId: f.user,
  });
  const input = {
    answers: { sum: ["A"] },
    version_id: published.version_id,
    domain_id: f.other.id,
    domain_problem_binding_id: "forged",
  };
  const submitted = await submitObjectivePaper(f.first.id, input, f.user);
  const [row] = await f.db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, submitted.submission_id),
  );
  assertEquals(row.domain_id, DEFAULT_DOMAIN_ID);
  assertEquals(row.domain_problem_binding_id, f.binding.id);
  assertEquals(row.score, 10000);
  assertEquals((await f.db.select({ id: domains.id }).from(domains)).length, 2);
});
