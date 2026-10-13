/**
 * PR #622 审查清单 #24 / #25 的存量迁移回归测试（真实 PostgreSQL）。
 *
 * 覆盖两条只有**存量数据**才能暴露的迁移语义：
 *
 * 1. **历史平台失败不得迁移成正式有效判定**（#25）。0103 的回填把存量
 *    `evaluation_results` 一律写成 `finished/graded` + `is_valid = true`；
 *    0109 必须把 SE / FE / cancelled 这类平台失败改写为 `platform_error`，
 *    清空有效成绩指针与分版本当前判定，同时**保留**最近尝试。
 * 2. **存量题目的草稿文件引用补齐**（#14/#24 的存量面）。0103 只回填了版本引用
 *    （`problem_version_objects`），0109 必须把最新版本的文件集合复制到已存在的
 *    草稿行（`problem_draft_objects`），且幂等。
 *
 * 直接执行迁移文件中的真实语句（与 0080 回填测试同一套做法），依赖 preload 的
 * 每用例事务回滚，不污染其他用例。无 DATABASE_URL（PGlite）时不具备执行
 * `DELETE ... USING` / 复合外键等真实语义，按项目约定 skip。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { getDb } from "../../src/shared/db/connection.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";
import { DEFAULT_DOMAIN_ID } from "../../src/shared/workspace/types.ts";

/** 需要真实 PostgreSQL 的迁移语义（PGlite 下跳过）。 */
const hasRealPg = !!Deno.env.get("DATABASE_URL");

const MIGRATION_PATH = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../drizzle/0109_legacy_platform_errors.sql",
);

const NOW = "2026-10-10T00:00:00.000Z";

/** 迁移夹具的稳定 UUID（重复执行/断言都需要固定值）。 */
const probeUuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 每个夹具场景的提交/尝试/当前判定三元组 ID。 */
interface ProbeIds {
  submissionId: string;
  attemptId: string;
  versionResultId: string;
}

const PROBE_IDS: Record<string, ProbeIds> = {
  ac: {
    submissionId: probeUuid(1),
    attemptId: probeUuid(2),
    versionResultId: probeUuid(3),
  },
  wa: {
    submissionId: probeUuid(4),
    attemptId: probeUuid(5),
    versionResultId: probeUuid(6),
  },
  ce: {
    submissionId: probeUuid(7),
    attemptId: probeUuid(8),
    versionResultId: probeUuid(9),
  },
  "user-tle": {
    submissionId: probeUuid(10),
    attemptId: probeUuid(11),
    versionResultId: probeUuid(12),
  },
  se: {
    submissionId: probeUuid(13),
    attemptId: probeUuid(14),
    versionResultId: probeUuid(15),
  },
  fe: {
    submissionId: probeUuid(16),
    attemptId: probeUuid(17),
    versionResultId: probeUuid(18),
  },
  cancelled: {
    submissionId: probeUuid(19),
    attemptId: probeUuid(20),
    versionResultId: probeUuid(21),
  },
  "ai-infra": {
    submissionId: probeUuid(22),
    attemptId: probeUuid(23),
    versionResultId: probeUuid(24),
  },
};

/** 读取迁移文件并按 drizzle 的语句分隔标记切分为可独立执行的语句。 */
function readMigrationStatements(): string[] {
  const content = Deno.readTextFileSync(MIGRATION_PATH);
  const withoutComments = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split("--> statement-breakpoint")
    .map((s) => s.trim().replace(/;+$/, "").trim())
    .filter((s) => s.length > 0);
}

/** 在测试事务内顺序执行迁移语句（迁移文件自带 breakpoint 分隔）。 */
async function applyMigration(): Promise<void> {
  const db = getDb();
  const statements = readMigrationStatements();
  assert(statements.length > 0, "0109 迁移文件不应为空");
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

/**
 * 清理本文件的历史探针数据。
 *
 * 真实 PG 模式下若上一轮运行留下了未回滚的探针行（例如用例在事务外失败），
 * 固定 id 会导致后续运行 primary key 冲突。探针 id 全局唯一前缀（pv109-），
 * 这里按外键顺序删除，保证用例可重复执行。
 */
async function cleanupProbes(): Promise<void> {
  const db = getDb();
  const probeProblems = sql`(SELECT id FROM problems WHERE id LIKE 'pv109-%')`;
  await db.execute(sql`
    DELETE FROM submission_version_results
    WHERE submission_id IN (
      SELECT id FROM submissions WHERE problem_id IN ${probeProblems}
    )
  `);
  await db.execute(sql`
    DELETE FROM evaluation_attempts
    WHERE submission_id IN (
      SELECT id FROM submissions WHERE problem_id IN ${probeProblems}
    )
  `);
  await db.execute(sql`
    DELETE FROM submissions WHERE problem_id IN ${probeProblems}
  `);
  await db.execute(sql`
    DELETE FROM problem_draft_objects WHERE problem_id IN ${probeProblems}
  `);
  await db.execute(sql`
    DELETE FROM problem_version_objects
    WHERE version_id IN (
      SELECT id FROM problem_versions WHERE problem_id IN ${probeProblems}
    )
  `);
  await db.execute(sql`
    DELETE FROM problem_drafts WHERE problem_id IN ${probeProblems}
  `);
  // 题目行的最新版指针先松开，否则删除版本会被 problems_latest_version_fk 拒绝
  await db.execute(sql`
    UPDATE problems SET latest_version_id = NULL WHERE id LIKE 'pv109-%'
  `);
  await db.execute(sql`
    DELETE FROM problem_versions WHERE problem_id IN ${probeProblems}
  `);
  await db.execute(sql`DELETE FROM problems WHERE id LIKE 'pv109-%'`);
  await db.execute(sql`
    DELETE FROM storage_objects WHERE storage_url LIKE 'local://pv109/%'
  `);
}

/** 插入一道题 + 一个迁移基线版本，返回版本 ID。 */
async function seedProblem(
  problemId: string,
  versionId: string,
  number: number,
): Promise<void> {
  const db = getDb();
  // 在当前隔离 schema 回放迁移语句，资源归属遵守现行 Schema。
  await db.execute(sql`
    INSERT INTO users (id, username, email, created_at, updated_at)
    VALUES ('0', 'pr622-lead-probe', 'pr622-lead@example.test', ${NOW}, ${NOW})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO problems (id, domain_id, title, description, number, owner_id,
                          difficulty, judge_type, created_at, updated_at)
    VALUES (${problemId}, ${DEFAULT_DOMAIN_ID}, ${problemId}, 'd', ${number}, '0', 'easy', 'dual',
            ${NOW}, ${NOW})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO problem_versions (id, problem_id, version, schema_version,
                                  origin, content, published_at, change_note)
    VALUES (${versionId}, ${problemId}, 1, 1, 'migration_baseline',
            '{"kind":"ai","title":"x","description":"d","samples":[],"submission_mode":"code","runtime_config":{},"template_content":"","artifact_max_size_mb":null,"llm_config":null}'::jsonb,
            ${NOW}, '')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE problems SET latest_version_id = ${versionId} WHERE id = ${problemId}
  `);
}

interface SubmissionProbe {
  submissionId: string;
  attemptId: string;
  versionResultId: string;
  /** 0103 回填后的形态：一律 finished/graded。 */
  legacyStatus: string;
  details: string;
}

/** 复刻 0103 回填后的存量形态：尝试 + 未知版本桶当前判定 + 有效成绩投影。 */
async function seedLegacyImport(probe: SubmissionProbe): Promise<void> {
  const db = getDb();
  // 先插提交（attempt 指针可空），再插尝试，最后回填指针：attempt 与提交之间的
  // 复合外键是延迟插入顺序无法满足的循环依赖，存量回填同样分两步。
  await db.execute(sql`
    INSERT INTO submissions (id, user_id, problem_id, language, code, status,
                             version_origin, submitted_version_id, created_at)
    VALUES (${probe.submissionId}, '0', 'pv109-p1', 'python', 'print(1)',
            'finished', 'legacy_unknown', NULL, ${NOW})
    ON CONFLICT (id) DO UPDATE SET
      is_valid = false, is_accepted = false,
      effective_attempt_id = NULL, accepted_attempt_id = NULL,
      latest_attempt_id = NULL, is_contest_valid = false,
      is_contest_accepted = false, contest_effective_attempt_id = NULL,
      contest_accepted_attempt_id = NULL
  `);
  await db.execute(sql`
    INSERT INTO evaluation_attempts (id, submission_id, problem_id,
                                     problem_version_id, sequence, source,
                                     state, result_kind, result_status, score,
                                     accepted, output, details, created_at,
                                     finished_at)
    VALUES (${probe.attemptId}, ${probe.submissionId}, 'pv109-p1', NULL, 0,
            'legacy_import', 'finished', 'graded', ${probe.legacyStatus}, 10000,
            true, '', ${probe.details}::jsonb, ${NOW}, ${NOW})
    ON CONFLICT (id) DO UPDATE SET
      result_kind = 'graded', result_status = ${probe.legacyStatus},
      details = ${probe.details}::jsonb
  `);
  await db.execute(sql`
    UPDATE submissions
    SET is_valid = true, is_accepted = true,
        effective_attempt_id = ${probe.attemptId},
        accepted_attempt_id = ${probe.attemptId},
        latest_attempt_id = ${probe.attemptId}
    WHERE id = ${probe.submissionId}
  `);
  await db.execute(sql`
    INSERT INTO submission_version_results (id, submission_id, problem_id,
                                            problem_version_id,
                                            current_attempt_id, updated_at)
    VALUES (${probe.versionResultId}, ${probe.submissionId},
            'pv109-p1', NULL, ${probe.attemptId}, ${NOW})
    ON CONFLICT (id) DO NOTHING
  `);
}

interface ProjectionRow {
  is_valid: boolean;
  is_accepted: boolean;
  effective_attempt_id: string | null;
  accepted_attempt_id: string | null;
  latest_attempt_id: string | null;
}

async function readProjection(submissionId: string): Promise<ProjectionRow> {
  const rows = unwrapRows<ProjectionRow>(
    await getDb().execute(sql`
      SELECT is_valid, is_accepted, effective_attempt_id, accepted_attempt_id,
             latest_attempt_id
      FROM submissions WHERE id = ${submissionId}
    `) as never,
  );
  assertEquals(rows.length, 1, `提交 ${submissionId} 应存在`);
  return rows[0];
}

Deno.test({
  name: "migration 0109: 历史平台失败不建立正式有效判定，正式判定保留",
  ignore: !hasRealPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanupProbes();
    await seedProblem("pv109-p1", "pv109-v1", 991001);
    const probes: Array<SubmissionProbe & { key: string }> = [
      {
        key: "ac",
        ...PROBE_IDS.ac,
        legacyStatus: "finished",
        details: '{"oi":{"verdict":"AC"}}',
      },
      {
        key: "wa",
        ...PROBE_IDS.wa,
        legacyStatus: "finished",
        details: '{"oi":{"verdict":"WA"}}',
      },
      {
        key: "ce",
        ...PROBE_IDS.ce,
        legacyStatus: "finished",
        details: '{"oi":{"verdict":"CE"}}',
      },
      {
        key: "user-tle",
        ...PROBE_IDS["user-tle"],
        legacyStatus: "finished",
        details: '{"oi":{"verdict":"TLE"}}',
      },
      {
        key: "se",
        ...PROBE_IDS.se,
        legacyStatus: "SystemError",
        details: "{}",
      },
      {
        key: "fe",
        ...PROBE_IDS.fe,
        legacyStatus: "FE",
        details: "{}",
      },
      {
        key: "cancelled",
        ...PROBE_IDS.cancelled,
        legacyStatus: "cancelled",
        details: "{}",
      },
      {
        key: "ai-infra",
        ...PROBE_IDS["ai-infra"],
        legacyStatus: "finished",
        details: '{"ai":{"infra_error":true}}',
      },
    ];
    for (const probe of probes) await seedLegacyImport(probe);

    await applyMigration();

    // 正式判定（AC/WA/CE/用户超时）保持有效，结果类别不变
    for (const key of ["ac", "wa", "ce", "user-tle"]) {
      const ids = PROBE_IDS[key];
      const row = await readProjection(ids.submissionId);
      assert(row.is_valid, `${key} 应保持有效`);
      assertEquals(row.effective_attempt_id, ids.attemptId);
      const kind = unwrapRows<{ result_kind: string }>(
        await getDb().execute(sql`
          SELECT result_kind FROM evaluation_attempts
          WHERE id = ${ids.attemptId}
        `) as never,
      );
      assertEquals(kind[0].result_kind, "graded", `${key} 应为 graded`);
    }

    // 平台失败：类别改写、有效判定清空、最近尝试保留、当前判定桶移除
    for (const key of ["se", "fe", "cancelled", "ai-infra"]) {
      const ids = PROBE_IDS[key];
      const row = await readProjection(ids.submissionId);
      assert(!row.is_valid, `${key} 不应有效`);
      assert(!row.is_accepted, `${key} 不应通过`);
      assertEquals(row.effective_attempt_id, null, `${key} 有效指针应为空`);
      assertEquals(row.accepted_attempt_id, null, `${key} 通过指针应为空`);
      assertEquals(
        row.latest_attempt_id,
        ids.attemptId,
        `${key} 应保留最近尝试`,
      );
      const kind = unwrapRows<{ result_kind: string }>(
        await getDb().execute(sql`
          SELECT result_kind FROM evaluation_attempts
          WHERE id = ${ids.attemptId}
        `) as never,
      );
      assertEquals(
        kind[0].result_kind,
        "platform_error",
        `${key} 应为平台错误`,
      );
      const vr = unwrapRows<{ id: string }>(
        await getDb().execute(sql`
          SELECT id FROM submission_version_results
          WHERE submission_id = ${ids.submissionId}
        `) as never,
      );
      assertEquals(vr.length, 0, `${key} 不应残留分版本当前判定`);
    }
  },
});

Deno.test({
  name: "migration 0109: 存量题目草稿文件引用补齐且可重复执行",
  ignore: !hasRealPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await cleanupProbes();
    const db = getDb();
    await seedProblem("pv109-p2", "pv109-v2", 991002);
    await db.execute(sql`
      INSERT INTO problem_drafts (problem_id, base_version_id, revision,
                                  content, updated_at)
      VALUES ('pv109-p2', 'pv109-v2', 1, '{"kind":"ai"}'::jsonb, ${NOW})
      ON CONFLICT (problem_id) DO UPDATE SET
        base_version_id = 'pv109-v2', revision = 1
    `);
    await db.execute(sql`
      INSERT INTO storage_objects (storage_url, sha256, byte_size, state,
                                   created_at)
      VALUES ('local://pv109/package.zip', NULL, NULL, 'unknown', ${NOW}),
             ('local://pv109/main.py', NULL, NULL, 'unknown', ${NOW})
      ON CONFLICT (storage_url) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO problem_version_objects (version_id, role, path, storage_url)
      VALUES ('pv109-v2', 'support_package', 'package.zip',
              'local://pv109/package.zip'),
             ('pv109-v2', 'oi_file', 'main.py', 'local://pv109/main.py')
      ON CONFLICT (version_id, role, path) DO NOTHING
    `);

    await applyMigration();

    const rows = unwrapRows<
      { role: string; path: string; storage_url: string }
    >(
      await db.execute(sql`
        SELECT role, path, storage_url FROM problem_draft_objects
        WHERE problem_id = 'pv109-p2' ORDER BY path
      `) as never,
    );
    assertEquals(rows.length, 2, "草稿应复制最新版本的两个文件引用");
    assertEquals(rows[0].path, "main.py");
    assertEquals(rows[1].path, "package.zip");

    // 幂等：再次执行不报错、不重复插入
    await applyMigration();
    const again = unwrapRows<{ count: number }>(
      await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM problem_draft_objects
        WHERE problem_id = 'pv109-p2'
      `) as never,
    );
    assertEquals(again[0].count, 2, "重复执行不应产生重复引用");
  },
});
