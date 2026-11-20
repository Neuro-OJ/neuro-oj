/**
 * `v0.10.6 → v0.11` 真实 PostgreSQL 端到端升级迁移回归测试。
 *
 * 在独立创建并清理的临时数据库上执行：
 * 1. 对源库应用官方 `0000..0115` Core 迁移 + `v0.10.6` Gateway SQL；
 * 2. 对目标库应用完整 `0000..0144` Core 迁移 + `v0.11` Gateway SQL；
 * 3. 灌入覆盖全表差异、循环外键、U 题重排、moment/私信清理、Gateway 的真实夹具；
 * 4. 验证 `dry-run` 零写入、原子提交全量校验、账本兼容以及幂等/误用拒绝条件。
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { PgDialect } from "drizzle-orm/pg-core";
import { type MigrationConfig, readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { assertDatabaseIdentifier } from "../../scripts/test-launcher-resources.ts";
import {
  readExpectedMigrations,
  validateMigrationLedger,
} from "../../src/shared/db/schema-compat.ts";
import {
  DEFAULT_DOMAIN_ID,
  runUpgradeFromV010,
  UpgradeV010Error,
  V010_LAST_MIGRATION_TAG,
} from "../../src/shared/db/upgrade-v010/index.ts";
import { assertOwnedTestDatabase } from "../helpers/db.ts";

const CORE_MIGRATIONS_DIR = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../drizzle",
);
const GATEWAY_MIGRATIONS_DIR = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../../noj-llm-gateway/drizzle",
);

const MIGRATION_CONFIG: MigrationConfig = {
  migrationsFolder: CORE_MIGRATIONS_DIR,
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

type PgClient = ReturnType<typeof postgres>;
type PgMigrationSession = Parameters<PgDialect["migrate"]>[1];

const V010_GATEWAY_FILES = [
  "0000_baseline.sql",
  "0001_llm_usage_billed_tokens.sql",
  "0002_remove_byok_created_by.sql",
  "0003_remove_provider_model.sql",
  "0004_llm_usage_attempt_scope.sql",
  "0005_provider_rate_limits.sql",
] as const;

const V011_GATEWAY_FILES = [
  "0000_baseline.sql",
  "0001_llm_usage_billed_tokens.sql",
  "0002_remove_byok_created_by.sql",
  "0003_remove_provider_model.sql",
  "0004_llm_usage_attempt_scope.sql",
  "0005_domain_ownership.sql",
  "0005_provider_rate_limits.sql",
  "20261013002359_lazy_groot.sql",
  "20261013054532_greedy_ironclad.sql",
  "20261021105927_motionless_iron_patriot.sql",
  "20261021115820_flat_forge.sql",
  "20261113134736_organic_leopardon.sql",
] as const;

function adminUrlForCurrentDatabase(): string {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL 未设置：升级 E2E 测试必须连接真实 PostgreSQL",
    );
  }
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlForName(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function migrationSession(client: PgClient): PgMigrationSession {
  return drizzlePg(client)._.session as unknown as PgMigrationSession;
}

async function applyGatewaySqlFiles(
  client: PgClient,
  files: readonly string[],
): Promise<void> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "llm_schema_migrations" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" text NOT NULL UNIQUE,
      "hash" text,
      "created_at" text
    )
  `);
  for (const file of files) {
    const raw = await Deno.readTextFile(`${GATEWAY_MIGRATIONS_DIR}/${file}`);
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await client.unsafe(stmt);
    }
    await client`
      INSERT INTO llm_schema_migrations (name, hash, created_at)
      VALUES (${file}, 'test-fixture', '1000000000000')
    `;
  }
}

async function seedV010FixtureData(source: PgClient): Promise<void> {
  const ts1 = "2025-06-01T01:00:00.000Z";
  const ts2 = "2025-06-01T02:00:00.000Z";
  const ts3 = "2025-06-01T03:00:00.000Z";

  await source`
    INSERT INTO users
      (id, username, email, password_hash, email_verified, session_version,
       bio, must_change_password, tfa_enabled, deleted_at, created_at, updated_at)
    VALUES
      ('0', 'root', 'root@example.test', 'hash', true, 0, '', false, false, NULL, ${ts1}, ${ts1}),
      ('u-admin', 'alice_admin', 'alice@example.test', 'hash', true, 0, '', false, false, NULL, ${ts1}, ${ts1}),
      ('u-member', 'bob_member', 'bob@example.test', 'hash', true, 0, '', false, false, NULL, ${ts2}, ${ts2}),
      ('u-deleted', 'deleted_user', 'del@example.test', 'hash', true, 0, '', false, false, ${ts3}, ${ts1}, ${ts3})
  `;

  await source`
    INSERT INTO roles (id, name, description, is_system, is_default, parent_id, created_at, updated_at)
    VALUES
      ('r-super', 'super_admin', 'Super', true, false, NULL, ${ts1}, ${ts1}),
      ('r-ops', 'ops_admin', 'Ops inherits super', false, false, 'r-super', ${ts1}, ${ts1}),
      ('r-user', 'user', 'Normal user', true, true, NULL, ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO permissions (id, resource, action, description)
    VALUES ('perm-full', 'admin', 'full_access', 'Full access')
  `;
  await source`
    INSERT INTO role_permissions (role_id, permission_id)
    VALUES ('r-super', 'perm-full')
  `;
  await source`
    INSERT INTO user_roles (user_id, role_id)
    VALUES ('u-admin', 'r-ops'), ('u-deleted', 'r-super'), ('u-member', 'r-user')
  `;

  await source`
    INSERT INTO storage_objects (storage_url, sha256, byte_size, state, created_at)
    VALUES
      ('s3://noj/pkg-p1.zip', 'sha-a', 1024, 'ready', ${ts1}),
      ('s3://noj/sub-artifact.zip', 'sha-b', 2048, 'ready', ${ts1}),
      ('s3://noj/deleted-pkg.zip', 'sha-c', 4096, 'deleted', ${ts1}),
      ('s3://noj/unknown-pkg.zip', NULL, NULL, 'unknown', ${ts1})
  `;

  await source`
    INSERT INTO problems
      (id, title, description, difficulty, type, number, owner_id,
       is_objective, visibility, submission_mode, latest_version_id,
       effective_version_mode, required_version_id, effective_policy_revision,
       created_at, updated_at)
    VALUES
      ('prob-p1', '标准题 P1', 'desc', 'easy', 'P', 1001, 'u-admin',
       false, 'public', 'code', NULL, 'any', NULL, 0, ${ts1}, ${ts1}),
      ('prob-paper', '客观题套卷', 'desc', 'medium', 'P', 1005, 'u-admin',
       true, 'public', 'code', NULL, 'any', NULL, 0, ${ts1}, ${ts1}),
      ('prob-u1', '用户自建题 U1001', 'desc', 'hard', 'U', 1001, 'u-member',
       false, 'private', 'artifact', NULL, 'any', NULL, 0, ${ts2}, ${ts2})
  `;

  await source`
    INSERT INTO problem_versions
      (id, problem_id, version, schema_version, origin, content, content_sha256,
       change_note, published_by, published_at)
    VALUES
      ('pv-p1-1', 'prob-p1', 1, 1, 'published', '{"stem":"P1"}'::jsonb, 'h1', 'v1', 'u-admin', ${ts1}),
      ('pv-paper-1', 'prob-paper', 1, 1, 'published', '{"stem":"Paper"}'::jsonb, 'h2', 'v1', 'u-admin', ${ts1}),
      ('pv-u1-1', 'prob-u1', 1, 1, 'published', '{"stem":"U1"}'::jsonb, 'h3', 'v1', 'u-member', ${ts2})
  `;

  // 同时覆盖 exact 模式 + required_version_id 循环外键约束
  await source`
    UPDATE problems
    SET latest_version_id = 'pv-p1-1',
        effective_version_mode = 'exact',
        required_version_id = 'pv-p1-1'
    WHERE id = 'prob-p1'
  `;
  await source`
    UPDATE problems SET latest_version_id = 'pv-paper-1' WHERE id = 'prob-paper'
  `;
  await source`
    UPDATE problems SET latest_version_id = 'pv-u1-1' WHERE id = 'prob-u1'
  `;

  await source`
    INSERT INTO problem_version_objects (version_id, role, path, storage_url)
    VALUES ('pv-p1-1', 'support_package', 'support.zip', 's3://noj/pkg-p1.zip')
  `;

  await source`
    INSERT INTO contests
      (id, public_id, title, description, start_time, end_time,
       ranking_visibility, freeze_duration_seconds, type, kind, config,
       is_public, affect_global_ranking, created_by, created_at, updated_at)
    VALUES
      ('c-1', 'contest-1', '旧竞赛', 'desc',
       '2025-07-01T08:00:00.000Z', '2025-07-01T12:00:00.000Z',
       'public', 0, 'kaggle', 'public', '{}'::jsonb, true, true, 'u-admin', ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO contest_problems
      (contest_id, problem_id, sort_order, label, score, pinned_version_id,
       effective_version_mode, required_version_id, effective_policy_revision)
    VALUES
      ('c-1', 'prob-p1', 0, 'A', 100, 'pv-p1-1', 'exact', 'pv-p1-1', 1)
  `;
  await source`
    INSERT INTO contest_clarifications
      (id, contest_id, problem_id, sender_id, content, reply_to_id, is_public, created_at)
    VALUES
      ('clar-1', 'c-1', 'prob-p1', 'u-member', '题目边界?', NULL, false, ${ts1}),
      ('clar-2', 'c-1', 'prob-p1', 'u-admin', 'n <= 10^5', 'clar-1', true, ${ts2})
  `;

  await source`
    INSERT INTO trainings (id, public_id, title, description, visibility, is_pinned, created_by, created_at, updated_at)
    VALUES
      ('tr-pub', 'tr-pub', '公开题单', '', 'public', false, 'u-admin', ${ts1}, ${ts1}),
      ('tr-priv', 'tr-priv', '私有题单', '', 'private', false, 'u-member', ${ts2}, ${ts2})
  `;
  await source`
    INSERT INTO training_problems (training_id, problem_id, position)
    VALUES ('tr-pub', 'prob-p1', 0)
  `;

  await source`
    INSERT INTO submissions
      (id, public_id, user_id, problem_id, contest_id, language, code,
       artifact_storage_url, submitted_version_id, version_origin, upgraded_from_id,
       is_valid, is_accepted, is_contest_valid, is_contest_accepted,
       global_policy_revision, contest_policy_revision, status, rejudge_seq, created_at)
    VALUES
      ('sub-1', 's-1', 'u-member', 'prob-p1', 'c-1', 'python', 'print(1)',
       's3://noj/sub-artifact.zip', 'pv-p1-1', 'known', NULL,
       true, true, true, true, 0, 1, 'accepted', 0, ${ts1}),
      ('sub-2', 's-2', 'u-member', 'prob-u1', NULL, 'python', 'print(2)',
       NULL, 'pv-u1-1', 'known', 'sub-1',
       true, true, false, false, 0, 0, 'accepted', 0, ${ts3})
  `;
  await source`
    INSERT INTO objective_submissions
      (id, paper_id, user_id, contest_id, submission_type, answers, status, score,
       details, submitted_version_id, version_origin, upgraded_from_id,
       is_valid, is_accepted, is_contest_valid, is_contest_accepted,
       global_policy_revision, contest_policy_revision, rejudge_seq, created_at)
    VALUES
      ('obj-1', 'prob-paper', 'u-member', NULL, 'practice', '{}'::jsonb, 'finished', 100,
       '{}'::jsonb, 'pv-paper-1', 'known', NULL,
       true, true, false, false, 0, 0, 0, ${ts2})
  `;
  await source`
    INSERT INTO evaluation_attempts
      (id, submission_id, objective_submission_id, problem_id, problem_version_id,
       sequence, source, state, result_kind, result_status, score, accepted,
       details, created_by, created_at)
    VALUES
      ('att-1', 'sub-1', NULL, 'prob-p1', 'pv-p1-1', 1, 'initial', 'finished', 'graded', 'accepted', 100, true, '{}'::jsonb, 'u-member', ${ts1}),
      ('att-2', 'sub-2', NULL, 'prob-u1', 'pv-u1-1', 1, 'initial', 'finished', 'graded', 'accepted', 100, true, '{}'::jsonb, 'u-member', ${ts3}),
      ('att-obj-1', NULL, 'obj-1', 'prob-paper', 'pv-paper-1', 1, 'initial', 'finished', 'graded', 'accepted', 100, true, '{}'::jsonb, 'u-member', ${ts2})
  `;
  await source`UPDATE submissions SET active_attempt_id = 'att-1', latest_attempt_id = 'att-1', effective_attempt_id = 'att-1', accepted_attempt_id = 'att-1', contest_effective_attempt_id = 'att-1', contest_accepted_attempt_id = 'att-1' WHERE id = 'sub-1'`;
  await source`UPDATE submissions SET active_attempt_id = 'att-2', latest_attempt_id = 'att-2', effective_attempt_id = 'att-2', accepted_attempt_id = 'att-2' WHERE id = 'sub-2'`;
  await source`UPDATE objective_submissions SET active_attempt_id = 'att-obj-1', latest_attempt_id = 'att-obj-1', effective_attempt_id = 'att-obj-1', accepted_attempt_id = 'att-obj-1' WHERE id = 'obj-1'`;

  await source`
    INSERT INTO community_boards (id, slug, name, description, sort_order, is_archived, created_at, updated_at)
    VALUES ('b-1', 'general', '综合', '', 0, false, ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO community_posts
      (id, public_id, type, author_id, problem_id, board_id, title, content,
       status, is_locked, is_pinned, is_official, published_at, created_at, updated_at)
    VALUES
      ('post-sol', 'p-sol', 'solution', 'u-member', 'prob-p1', NULL, 'P1 题解', 'body', 'published', false, false, false, ${ts1}, ${ts1}, ${ts1}),
      ('post-disc', 'p-disc', 'discussion', 'u-member', NULL, 'b-1', '讨论帖', 'body', 'published', false, false, false, ${ts1}, ${ts1}, ${ts1}),
      ('post-moment', 'p-mom', 'moment', 'u-member', NULL, NULL, NULL, '动态内容', 'published', false, false, false, ${ts1}, ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO community_comments
      (id, post_id, author_id, parent_id, content, status, created_at, updated_at)
    VALUES
      ('com-disc-1', 'post-disc', 'u-admin', NULL, '好帖', 'published', ${ts1}, ${ts1}),
      ('com-disc-2', 'post-disc', 'u-member', 'com-disc-1', '谢谢', 'published', ${ts2}, ${ts2}),
      ('com-mom-1', 'post-moment', 'u-admin', NULL, '动态评论', 'published', ${ts1}, ${ts1}),
      ('com-mom-2', 'post-moment', 'u-member', 'com-mom-1', '级联回复', 'published', ${ts2}, ${ts2})
  `;
  await source`
    INSERT INTO conversations (id, user1_id, user2_id, last_message_at, created_at)
    VALUES ('conv-1', 'u-admin', 'u-member', ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at)
    VALUES ('msg-1', 'conv-1', 'u-member', 'text', 'hi', ${ts1})
  `;
  await source`
    INSERT INTO community_reports
      (id, reporter_id, post_id, comment_id, message_id, content_type,
       category, reason, content_snapshot, status, updated_at, created_at)
    VALUES
      ('rep-disc', 'u-admin', 'post-disc', NULL, NULL, 'post', '其他', 'check', 'snap', 'pending', ${ts1}, ${ts1}),
      ('rep-mom', 'u-admin', 'post-moment', NULL, NULL, 'post', '其他', 'check', 'snap', 'pending', ${ts1}, ${ts1}),
      ('rep-msg', 'u-admin', NULL, NULL, 'msg-1', 'message', '其他', 'check', 'snap', 'pending', ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO community_moderation_actions
      (id, moderator_id, action, target_type, target_id, reason, metadata, created_at)
    VALUES
      ('mod-post', 'u-admin', 'hide', 'post', 'post-disc', 'r', '{}'::jsonb, ${ts1}),
      ('mod-ban', 'u-admin', 'ban', 'user_ban', 'u-deleted', 'r', '{}'::jsonb, ${ts1})
  `;
  await source`
    INSERT INTO community_notifications
      (id, recipient_id, actor_id, type, post_id, comment_id, data, read_at, created_at)
    VALUES
      ('noti-reply', 'u-member', 'u-admin', 'reply', 'post-disc', 'com-disc-1', '{}'::jsonb, NULL, ${ts1}),
      ('noti-follow', 'u-member', 'u-admin', 'follow', NULL, NULL, '{}'::jsonb, NULL, ${ts2}),
      ('noti-mom', 'u-member', 'u-admin', 'reply', 'post-moment', 'com-mom-1', '{}'::jsonb, NULL, ${ts3})
  `;

  await source`
    INSERT INTO system_settings (key, value, description, is_secret, updated_at, updated_by)
    VALUES
      ('site_name', 'Neuro OJ', 'Name', false, ${ts1}, 'u-admin'),
      ('tsa_provider', 'legacy', 'Removed', false, ${ts1}, 'u-admin'),
      ('llm_default_provider_id', 'prov-1', 'Default LLM provider', false, ${ts1}, 'u-admin'),
      ('llm_default_model', 'gpt-test', 'Default LLM model', false, ${ts2}, 'u-admin')
  `;
  await source`
    INSERT INTO llm_model_aliases (alias, provider_id, model, description, updated_at, updated_by)
    VALUES
      ('default', 'prov-1', 'gpt-test', 'Default', ${ts1}, 'u-admin'),
      ('fast', 'prov-1', 'gpt-fast', 'Fast alias', ${ts1}, 'u-admin')
  `;
  await source`
    INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, detail, ip_address, created_at)
    VALUES
      ('audit-keep', 'u-admin', 'users.ban', 'user', 'u-deleted', '{}'::jsonb, '127.0.0.1', ${ts1}),
      ('audit-drop', 'u-admin', 'roles.create', 'role', 'r-ops', '{}'::jsonb, '127.0.0.1', ${ts2}),
      ('audit-drop2', 'u-admin', 'community.board_role_grant_update', 'board', 'b-1', '{}'::jsonb, '127.0.0.1', ${ts3})
  `;
  await source`
    INSERT INTO search_entries
      (id, entity_type, entity_id, title, body, metadata, owner_id,
       participant_ids, deleted_by_user_ids, is_public, admin_only, is_active, created_at, updated_at)
    VALUES
      ('se-prob', 'problem', 'prob-p1', '标准题 P1', 'body', '{}'::jsonb, 'u-admin',
       ARRAY['u-admin', 'u-member']::text[], ARRAY[]::text[], true, false, true, ${ts1}, ${ts1}),
      ('se-mom', 'post', 'post-moment', '动态', 'body', '{}'::jsonb, 'u-member',
       ARRAY[]::text[], ARRAY[]::text[], true, false, true, ${ts1}, ${ts1}),
      ('se-msg', 'message', 'msg-1', '私信', 'hi', '{}'::jsonb, 'u-member',
       ARRAY['u-admin', 'u-member']::text[], ARRAY[]::text[], false, false, true, ${ts1}, ${ts1})
  `;

  await source`
    INSERT INTO llm_providers
      (id, name, base_url, cost_per_1k_tokens, encrypted_api_key, enabled, rpm_limit, tpm_limit, created_at, updated_at)
    VALUES
      ('prov-1', 'TestProvider', 'http://localhost:9999/v1', 0.01, 'enc-key', true, 60, 10000, ${ts1}, ${ts1})
  `;
  await source`
    INSERT INTO llm_usage
      (id, submission_id, attempt_id, problem_version_id, problem_id, user_id, provider_id, model,
       request_messages, request_params, prompt_tokens, completion_tokens, total_tokens,
       cached_prompt_tokens, billed_prompt_tokens, billed_total_tokens,
       estimated_cost, latency_ms, status, error_code, prompt_hash, created_at)
    VALUES
      ('usage-1', 'sub-1', 'att-1', 'pv-p1-1', 'prob-p1', 'u-member', 'prov-1', 'gpt-test',
       '[{"role":"user","content":"hi"}]'::jsonb, '{}'::jsonb, 10, 5, 15,
       0, 10, 15, 1, 50, 'ok', NULL, 'hash-u1', ${ts1})
  `;
  await source`
    INSERT INTO llm_quotas
      (id, scope_type, scope_id, window_type, max_calls, max_tokens, max_cost, created_at, updated_at)
    VALUES
      ('q-global', 'global', '', 'day', 100, 100000, 500, ${ts1}, ${ts1}),
      ('q-user', 'user', 'u-member', 'day', 20, 10000, 50, ${ts1}, ${ts1})
  `;
}

Deno.test({
  name:
    "upgrade-v010 pg e2e: v0.10.6 全量数据库 -> v0.11 逻辑升级、干跑、幂等拒绝与网关回填",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const runDb = await assertOwnedTestDatabase();
    assert(runDb.startsWith("noj_test_"));

    const adminUrl = adminUrlForCurrentDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const sourceDb = assertDatabaseIdentifier(`noj_test_upgv010_${suffix}_src`);
    const targetDb = assertDatabaseIdentifier(`noj_test_upgv010_${suffix}_dst`);
    const created: string[] = [];

    try {
      await admin.unsafe(`CREATE DATABASE "${sourceDb}"`);
      created.push(sourceDb);
      await admin.unsafe(`CREATE DATABASE "${targetDb}"`);
      created.push(targetDb);

      const sourceUrl = databaseUrlForName(adminUrl, sourceDb);
      const targetUrl = databaseUrlForName(adminUrl, targetDb);
      const source = postgres(sourceUrl, { max: 1 });
      const target = postgres(targetUrl, { max: 1 });

      try {
        const allMigrations = readMigrationFiles(MIGRATION_CONFIG);
        const journal = JSON.parse(
          await Deno.readTextFile(`${CORE_MIGRATIONS_DIR}/meta/_journal.json`),
        ) as { entries: Array<{ tag: string }> };
        const index0115 = journal.entries.findIndex(
          (e) => e.tag === V010_LAST_MIGRATION_TAG,
        );
        assertEquals(index0115, 114);

        const v010Migrations = allMigrations.slice(0, index0115 + 1);
        await new PgDialect().migrate(
          v010Migrations,
          migrationSession(source),
          MIGRATION_CONFIG,
        );
        await applyGatewaySqlFiles(source, V010_GATEWAY_FILES);
        await seedV010FixtureData(source);

        await new PgDialect().migrate(
          allMigrations,
          migrationSession(target),
          MIGRATION_CONFIG,
        );
        await applyGatewaySqlFiles(target, V011_GATEWAY_FILES);

        // 1. 同库拦截
        const sameErr = await assertRejects(() =>
          runUpgradeFromV010({
            sourceUrl,
            targetUrl: sourceUrl,
            migrationsDir: CORE_MIGRATIONS_DIR,
          })
        );
        assert(sameErr instanceof UpgradeV010Error);
        assertEquals(sameErr.code, "SAME_DATABASE");

        // 2. Dry-run 只读规划，不写入任何目标行
        const dryReport = await runUpgradeFromV010({
          sourceUrl,
          targetUrl,
          dryRun: true,
          migrationsDir: CORE_MIGRATIONS_DIR,
        });
        assertEquals(dryReport.dryRun, true);
        assertEquals(dryReport.sourceMigrationCount, 115);
        assertEquals(dryReport.targetMigrationCount, allMigrations.length);
        assertEquals(dryReport.defaultDomainOwnerId, "u-admin");
        assertEquals(dryReport.archivedSummary.renumberedProblems.length, 1);
        assertEquals(
          dryReport.archivedSummary.renumberedProblems[0]?.newNumber,
          1006,
        );
        assertEquals(dryReport.archivedSummary.skippedMomentPosts.length, 1);
        assertEquals(dryReport.archivedSummary.skippedMomentComments, 2);
        assertEquals(dryReport.archivedSummary.skippedMessageReports, 1);
        assertEquals(dryReport.archivedSummary.skippedMomentReports, 1);
        assertEquals(dryReport.archivedSummary.skippedAuditLogs, 2);
        assertEquals(dryReport.gateway.detected, true);

        const dryTargetUsers =
          await target`SELECT count(*)::int AS cnt FROM users`;
        assertEquals(dryTargetUsers[0]?.cnt, 0);

        // 3. 执行真实迁移
        const realReport = await runUpgradeFromV010({
          sourceUrl,
          targetUrl,
          dryRun: false,
          migrationsDir: CORE_MIGRATIONS_DIR,
        });
        assertEquals(realReport.dryRun, false);
        assertEquals(realReport.tableCounts.users, 4);
        assertEquals(realReport.tableCounts.problems, 3);
        assertEquals(realReport.tableCounts.domain_problem_bindings, 3);
        assertEquals(realReport.tableCounts.problem_binding_history, 3);
        assertEquals(realReport.tableCounts.community_posts, 2);
        assertEquals(realReport.tableCounts.community_comments, 2);
        assertEquals(realReport.tableCounts.community_reports, 1);
        assertEquals(realReport.tableCounts.notifications, 3);
        assertEquals(realReport.tableCounts.audit_logs, 1);
        assertEquals(realReport.tableCounts.search_entries, 1);
        assertEquals(realReport.tableCounts.domain_storage_objects, 2);
        assertEquals(realReport.tableCounts.domain_resource_counters, 3);

        // 验证转换结果与约束
        const usersRows = await target`
          SELECT id, role, search_vector IS NOT NULL AS has_vec FROM users ORDER BY id
        `;
        assertEquals(
          usersRows.map((u) => [u.id, u.role, u.has_vec]),
          [
            ["0", "admin", true],
            ["u-admin", "admin", true],
            ["u-deleted", "user", true],
            ["u-member", "user", true],
          ],
        );

        const domainsRows = await target`
          SELECT id, slug, owner_id, next_problem_number FROM domains
        `;
        assertEquals([...domainsRows], [{
          id: DEFAULT_DOMAIN_ID,
          slug: "main",
          owner_id: "u-admin",
          next_problem_number: 1007,
        }]);

        const problemRows = await target`
          SELECT id, number, latest_version_id, effective_version_mode, required_version_id
          FROM problems ORDER BY number ASC
        `;
        assertEquals(
          problemRows.map((p) => [p.id, p.number, p.effective_version_mode]),
          [
            ["prob-p1", 1001, "exact"],
            ["prob-paper", 1005, "any"],
            ["prob-u1", 1006, "any"],
          ],
        );

        const seqRows = await target`
          SELECT id, receipt_sequence::int AS seq, active_attempt_id
          FROM submissions ORDER BY receipt_sequence ASC
        `;
        const objSeqRows = await target`
          SELECT id, receipt_sequence::int AS seq, active_attempt_id
          FROM objective_submissions
        `;
        assertEquals([...seqRows], [
          { id: "sub-1", seq: 1, active_attempt_id: "att-1" },
          { id: "sub-2", seq: 3, active_attempt_id: "att-2" },
        ]);
        assertEquals([...objSeqRows], [
          { id: "obj-1", seq: 2, active_attempt_id: "att-obj-1" },
        ]);
        const nextSeq =
          await target`SELECT nextval('submission_receipt_sequence')::int AS v`;
        assertEquals(nextSeq[0]?.v, 4);

        const trainingStates = await target`
          SELECT id, state FROM trainings ORDER BY id ASC
        `;
        assertEquals([...trainingStates], [
          { id: "tr-priv", state: "draft" },
          { id: "tr-pub", state: "published" },
        ]);

        const notiRows = await target`
          SELECT id, domain_id, post_id, comment_id FROM notifications ORDER BY id ASC
        `;
        assertEquals([...notiRows], [
          {
            id: "noti-follow",
            domain_id: null,
            post_id: null,
            comment_id: null,
          },
          {
            id: "noti-mom",
            domain_id: DEFAULT_DOMAIN_ID,
            post_id: null,
            comment_id: null,
          },
          {
            id: "noti-reply",
            domain_id: DEFAULT_DOMAIN_ID,
            post_id: "post-disc",
            comment_id: "com-disc-1",
          },
        ]);

        const modRows = await target`
          SELECT id, domain_id FROM community_moderation_actions ORDER BY id ASC
        `;
        assertEquals([...modRows], [
          { id: "mod-ban", domain_id: null },
          { id: "mod-post", domain_id: DEFAULT_DOMAIN_ID },
        ]);

        const auditRows = await target`
          SELECT id, action FROM audit_logs ORDER BY id ASC
        `;
        assertEquals([...auditRows], [
          { id: "audit-keep", action: "users.ban" },
        ]);

        const counters = await target`
          SELECT resource, used::int AS used FROM domain_resource_counters ORDER BY resource ASC
        `;
        assertEquals([...counters], [
          { resource: "members", used: 2 },
          { resource: "problems", used: 3 },
          { resource: "storage_bytes", used: 3072 },
        ]);

        const seRows = await target`
          SELECT id, domain_id, participant_ids FROM search_entries
        `;
        assertEquals([...seRows], [{
          id: "se-prob",
          domain_id: DEFAULT_DOMAIN_ID,
          participant_ids: ["u-admin", "u-member"],
        }]);

        const gwUsage = await target`
          SELECT id, domain_id, principal_type, principal_id FROM llm_usage
        `;
        assertEquals([...gwUsage], [{
          id: "usage-1",
          domain_id: DEFAULT_DOMAIN_ID,
          principal_type: "user",
          principal_id: null,
        }]);

        const gwQuotas = await target`
          SELECT id, domain_id FROM llm_quotas ORDER BY id ASC
        `;
        assertEquals([...gwQuotas], [
          { id: "q-global", domain_id: "" },
          { id: "q-user", domain_id: DEFAULT_DOMAIN_ID },
        ]);

        const gwSettings = await target`
          SELECT domain_id, provider_id, model, updated_by FROM llm_gateway_domain_settings
        `;
        assertEquals([...gwSettings], [{
          domain_id: DEFAULT_DOMAIN_ID,
          provider_id: "prov-1",
          model: "gpt-test",
          updated_by: "u-admin",
        }]);

        const gwAliases = await target`
          SELECT alias, revision FROM llm_gateway_model_aliases
        `;
        assertEquals([...gwAliases], [{ alias: "fast", revision: 1 }]);

        // 物化视图可直接查询，账本与目标版本完全匹配
        const rankings =
          await target`SELECT count(*)::int AS cnt FROM user_rankings`;
        assert(typeof rankings[0]?.cnt === "number");
        const expectedAll = await readExpectedMigrations(CORE_MIGRATIONS_DIR);
        const actualTarget = await target<
          { hash: string; createdAt: string }[]
        >`
          SELECT hash, created_at::text AS "createdAt"
          FROM drizzle.__drizzle_migrations ORDER BY id ASC
        `;
        assertEquals(
          validateMigrationLedger(expectedAll, actualTarget, "startup"),
          null,
        );

        // 4. 不可对非空目标库重复执行
        const nonEmptyErr = await assertRejects(() =>
          runUpgradeFromV010({
            sourceUrl,
            targetUrl,
            migrationsDir: CORE_MIGRATIONS_DIR,
          })
        );
        assert(nonEmptyErr instanceof UpgradeV010Error);
        assertEquals(nonEmptyErr.code, "TARGET_NOT_EMPTY");

        // 5. 不可把 v0.11 库当作 v0.10.6 源库
        const badSourceErr = await assertRejects(() =>
          runUpgradeFromV010({
            sourceUrl: targetUrl,
            targetUrl: sourceUrl,
            migrationsDir: CORE_MIGRATIONS_DIR,
          })
        );
        assert(badSourceErr instanceof UpgradeV010Error);
        assertEquals(badSourceErr.code, "SOURCE_UNSUPPORTED_VERSION");
      } finally {
        await Promise.allSettled([
          source.end({ timeout: 5 }),
          target.end({ timeout: 5 }),
        ]);
      }
    } finally {
      for (const dbName of [...created].reverse()) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      }
      await admin.end({ timeout: 5 });
    }
  },
});
