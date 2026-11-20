/**
 * `v0.10.6 → v0.11` 逻辑数据库升级主协调器。
 *
 * 保证源库全程 `READ ONLY`，目标库在单事务内原子写入（失败自动完整回滚），
 * 并支持 `--dry-run` 只读校验与规划。
 */

import postgres from "postgres";
import { resolveMigrationsDirectory } from "../migrations-path.ts";
import { buildUpgradePlan, type UpgradeExecutionPlan } from "./build-plan.ts";
import {
  countTableRows,
  getTargetInsertColumns,
  insertRowsBatched,
  type JsonParamSerializer,
  type PgClient,
  type PgExecutor,
  type TargetColumnMeta,
} from "./copy-helpers.ts";
import { applyGatewayMigration } from "./migrate-gateway.ts";
import {
  assertDistinctDatabases,
  validateSourceDatabase,
  validateTargetDatabase,
} from "./migrate-validation.ts";
import { DEFAULT_DOMAIN_ID } from "./transform.ts";
import {
  type UpgradeFromV010Options,
  type UpgradeReport,
  UpgradeV010Error,
} from "./types.ts";

/** 按严格外键拓扑依赖排列的目标表写入顺序（共 53 张已填充核心表）。 */
const CORE_INSERT_ORDER: readonly string[] = [
  "users",
  "domains",
  "domain_limits",
  "domain_memberships",
  "system_settings",
  "domain_llm_settings",
  "legal_documents",
  "legal_document_versions",
  "user_bans",
  "ip_bans",
  "oauth_accounts",
  "tfa_recovery_codes",
  "password_reset_tokens",
  "check_ins",
  "user_consents",
  "data_requests",
  "email_delivery_events",
  "email_suppressions",
  "judge_images",
  "llm_model_aliases",
  "llm_token_revocations",
  "storage_objects",
  "storage_object_reservations",
  "tags",
  "problems",
  "problem_versions",
  "domain_problem_bindings",
  "problem_binding_history",
  "problem_drafts",
  "problem_tags",
  "problem_draft_objects",
  "problem_version_objects",
  "contests",
  "contest_problems",
  "contest_participants",
  "contest_clarifications",
  "contest_ranking_snapshots",
  "trainings",
  "training_problems",
  "submissions",
  "objective_submissions",
  "evaluation_attempts",
  "submission_jobs",
  "submission_job_items",
  "submission_version_results",
  "self_tests",
  "community_boards",
  "community_posts",
  "community_comments",
  "community_sanctions",
  "community_moderation_actions",
  "community_reports",
  "notifications",
  "announcements",
  "audit_logs",
  "search_entries",
  "query_projection_revisions",
  "sse_events",
];

const UNNEST_BATCH_SIZE = 250;

function assertValidDbUrl(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new UpgradeV010Error("INVALID_OPTIONS", `缺少${label}连接串`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UpgradeV010Error(
      "INVALID_OPTIONS",
      `${label}连接串格式非法（必须为 postgres:// 或 postgresql:// URL）`,
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new UpgradeV010Error(
      "INVALID_OPTIONS",
      `${label}连接串协议非法（仅支持 postgres:// / postgresql://）`,
    );
  }
}

async function restoreProblemCircularFks(
  tx: PgExecutor,
  plan: UpgradeExecutionPlan,
): Promise<void> {
  const toUpdate = plan.problemRestores.filter(
    (p) =>
      p.latest_version_id !== null ||
      p.required_version_id !== null ||
      p.effective_version_mode !== "any",
  );
  for (let i = 0; i < toUpdate.length; i += UNNEST_BATCH_SIZE) {
    const chunk = toUpdate.slice(i, i + UNNEST_BATCH_SIZE);
    const ids = chunk.map((c) => c.id);
    const latestIds = chunk.map((c) => c.latest_version_id);
    const modes = chunk.map((c) => c.effective_version_mode);
    const requiredIds = chunk.map((c) => c.required_version_id);
    await tx.unsafe(
      `UPDATE "problems" AS p
       SET latest_version_id = v.latest_version_id,
           effective_version_mode = v.effective_version_mode,
           required_version_id = v.required_version_id
       FROM (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
           AS t(id, latest_version_id, effective_version_mode, required_version_id)
       ) AS v
       WHERE p.id = v.id`,
      [ids, latestIds, modes, requiredIds],
    );
  }
}

async function restoreSubmissionAttemptPointers(
  tx: PgExecutor,
  tableName: "submissions" | "objective_submissions",
  restores: UpgradeExecutionPlan["submissionRestores"],
): Promise<void> {
  const toUpdate = restores.filter(
    (r) =>
      r.active_attempt_id !== null ||
      r.latest_attempt_id !== null ||
      r.effective_attempt_id !== null ||
      r.accepted_attempt_id !== null ||
      r.contest_effective_attempt_id !== null ||
      r.contest_accepted_attempt_id !== null,
  );
  for (let i = 0; i < toUpdate.length; i += UNNEST_BATCH_SIZE) {
    const chunk = toUpdate.slice(i, i + UNNEST_BATCH_SIZE);
    await tx.unsafe(
      `UPDATE "${tableName}" AS s
       SET active_attempt_id = v.active_attempt_id,
           latest_attempt_id = v.latest_attempt_id,
           effective_attempt_id = v.effective_attempt_id,
           accepted_attempt_id = v.accepted_attempt_id,
           contest_effective_attempt_id = v.contest_effective_attempt_id,
           contest_accepted_attempt_id = v.contest_accepted_attempt_id
       FROM (
         SELECT * FROM UNNEST(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
         ) AS t(
           id,
           active_attempt_id,
           latest_attempt_id,
           effective_attempt_id,
           accepted_attempt_id,
           contest_effective_attempt_id,
           contest_accepted_attempt_id
         )
       ) AS v
       WHERE s.id = v.id`,
      [
        chunk.map((c) => c.id),
        chunk.map((c) => c.active_attempt_id),
        chunk.map((c) => c.latest_attempt_id),
        chunk.map((c) => c.effective_attempt_id),
        chunk.map((c) => c.accepted_attempt_id),
        chunk.map((c) => c.contest_effective_attempt_id),
        chunk.map((c) => c.contest_accepted_attempt_id),
      ],
    );
  }
}

async function populateDomainStorageAndCounters(
  tx: PgExecutor,
  plan: UpgradeExecutionPlan,
  columnsByTable: Map<string, TargetColumnMeta[]>,
  serializeJson: JsonParamSerializer,
): Promise<{ storageObjectsCount: number; countersCount: number }> {
  // 与 storage-quota.ts 的 initializeOwnedObjects 口径严格一致
  await tx.unsafe(
    `INSERT INTO "domain_storage_objects" ("domain_id", "storage_url", "byte_size", "created_at")
     SELECT $1::text, o.storage_url, o.byte_size, $2::text
     FROM (
       SELECT o.storage_url
       FROM "problem_draft_objects" o
       JOIN "problems" p ON p.id = o.problem_id
       WHERE p.domain_id = $1::text
       UNION
       SELECT o.storage_url
       FROM "problem_version_objects" o
       JOIN "problem_versions" v ON v.id = o.version_id
       JOIN "problems" p ON p.id = v.problem_id
       WHERE p.domain_id = $1::text
       UNION
       SELECT artifact_storage_url AS storage_url
       FROM "submissions"
       WHERE domain_id = $1::text AND artifact_storage_url IS NOT NULL
     ) AS refs
     JOIN "storage_objects" o ON o.storage_url = refs.storage_url
     WHERE o.byte_size IS NOT NULL AND o.state <> 'deleted'
     ON CONFLICT ("domain_id", "storage_url") DO NOTHING`,
    [DEFAULT_DOMAIN_ID, plan.executedAt],
  );

  const storageRows = await tx<{ cnt: string; total_bytes: string }[]>`
    SELECT
      count(*)::text AS cnt,
      COALESCE(sum(byte_size), 0)::text AS total_bytes
    FROM domain_storage_objects
    WHERE domain_id = ${DEFAULT_DOMAIN_ID}
  `;
  const storageObjectsCount = Number(storageRows[0]?.cnt ?? "0");
  const totalStorageBytes = String(storageRows[0]?.total_bytes ?? "0");

  const counterCols = columnsByTable.get("domain_resource_counters") ??
    await getTargetInsertColumns(tx, "domain_resource_counters");

  const counterRows = [
    {
      domain_id: DEFAULT_DOMAIN_ID,
      resource: "members",
      used: plan.tables.domain_memberships?.length ?? 0,
      reserved: 0,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      resource: "problems",
      used: plan.tables.problems?.length ?? 0,
      reserved: 0,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      resource: "storage_bytes",
      used: totalStorageBytes,
      reserved: 0,
    },
  ];
  const countersCount = await insertRowsBatched(
    tx,
    "domain_resource_counters",
    counterCols,
    counterRows,
    serializeJson,
  );
  return { storageObjectsCount, countersCount };
}

function estimateStorageObjectsCount(plan: UpgradeExecutionPlan): number {
  const validUrls = new Set(
    (plan.tables.storage_objects ?? [])
      .filter((o) =>
        o.byte_size !== null && o.byte_size !== undefined &&
        String(o.state) !== "deleted"
      )
      .map((o) => String(o.storage_url)),
  );
  const referenced = new Set<string>();
  for (const row of plan.tables.problem_draft_objects ?? []) {
    const url = String(row.storage_url);
    if (validUrls.has(url)) referenced.add(url);
  }
  for (const row of plan.tables.problem_version_objects ?? []) {
    const url = String(row.storage_url);
    if (validUrls.has(url)) referenced.add(url);
  }
  for (const row of plan.tables.submissions ?? []) {
    if (row.artifact_storage_url) {
      const url = String(row.artifact_storage_url);
      if (validUrls.has(url)) referenced.add(url);
    }
  }
  return referenced.size;
}

async function introspectAllTargetColumns(
  tx: PgExecutor,
  plan: UpgradeExecutionPlan,
): Promise<Map<string, TargetColumnMeta[]>> {
  const columnsByTable = new Map<string, TargetColumnMeta[]>();
  const allTables = new Set<string>([
    ...CORE_INSERT_ORDER,
    "domain_storage_objects",
    "domain_resource_counters",
  ]);
  if (plan.gateway.detected) {
    allTables.add("llm_providers");
    allTables.add("llm_usage");
    allTables.add("llm_quotas");
    allTables.add("llm_gateway_domain_settings");
    allTables.add("llm_gateway_model_aliases");
  }
  for (const table of allTables) {
    columnsByTable.set(table, await getTargetInsertColumns(tx, table));
  }
  return columnsByTable;
}

async function executeTargetTransaction(
  target: PgClient,
  plan: UpgradeExecutionPlan,
): Promise<Record<string, number>> {
  const serializeJson: JsonParamSerializer = (value: unknown) =>
    target.json(value as never);
  return await target.begin(async (tx) => {
    const columnsByTable = await introspectAllTargetColumns(tx, plan);
    const counts: Record<string, number> = {};

    for (const tableName of CORE_INSERT_ORDER) {
      const rows = plan.tables[tableName] ?? [];
      if (tableName === "query_projection_revisions") {
        // 清理空库迁移自带的 'global' 哨兵行后再回放源库进度
        await tx.unsafe(`DELETE FROM "query_projection_revisions"`);
      }
      counts[tableName] = await insertRowsBatched(
        tx,
        tableName,
        columnsByTable.get(tableName)!,
        rows,
        serializeJson,
      );

      if (tableName === "problem_versions") {
        await restoreProblemCircularFks(tx, plan);
      }
      if (tableName === "evaluation_attempts") {
        await restoreSubmissionAttemptPointers(
          tx,
          "submissions",
          plan.submissionRestores,
        );
        await restoreSubmissionAttemptPointers(
          tx,
          "objective_submissions",
          plan.objectiveSubmissionRestores,
        );
      }
    }

    const { storageObjectsCount, countersCount } =
      await populateDomainStorageAndCounters(
        tx,
        plan,
        columnsByTable,
        serializeJson,
      );
    counts["domain_storage_objects"] = storageObjectsCount;
    counts["domain_resource_counters"] = countersCount;

    const gwSummary = await applyGatewayMigration(
      tx,
      plan.gateway,
      serializeJson,
    );
    if (gwSummary.detected) {
      counts["llm_providers"] = gwSummary.copiedProviders;
      counts["llm_usage"] = gwSummary.copiedUsage;
      counts["llm_quotas"] = gwSummary.copiedQuotas;
      counts["llm_gateway_domain_settings"] =
        gwSummary.backfilledDomainSettings;
      counts["llm_gateway_model_aliases"] = gwSummary.backfilledModelAliases;
    }

    if (plan.maxReceiptSequence > 0) {
      await tx`
        SELECT setval('submission_receipt_sequence', ${plan.maxReceiptSequence}, true)
      `;
    }

    const matViewCheck = await tx<{ exists: boolean }[]>`
      SELECT to_regclass('public.user_rankings') IS NOT NULL AS exists
    `;
    if (matViewCheck[0]?.exists) {
      await tx.unsafe(`REFRESH MATERIALIZED VIEW "user_rankings"`);
    }

    // 事务内行数核对，确保目标库行数与计划完全一致
    for (const [tableName, expectedCount] of Object.entries(counts)) {
      const actualCount = await countTableRows(tx, tableName);
      if (actualCount !== expectedCount) {
        throw new UpgradeV010Error(
          "TRANSACTION_FAILED",
          `目标表 ${tableName} 写入后行数校验失败（期望 ${expectedCount}，实际 ${actualCount}）`,
          { table: tableName, expectedCount, actualCount },
        );
      }
    }

    return counts;
  });
}

/**
 * 从只读 `v0.10.6` 源库向全新空 `v0.11` 目标库执行逻辑升级与历史数据迁移。
 */
export async function runUpgradeFromV010(
  options: UpgradeFromV010Options,
): Promise<UpgradeReport> {
  assertValidDbUrl(options.sourceUrl, "源库");
  assertValidDbUrl(options.targetUrl, "目标库");

  const migrationsDir = options.migrationsDir ?? resolveMigrationsDirectory();
  const executedAt = options.now ? options.now() : new Date().toISOString();
  const dryRun = options.dryRun ?? false;

  const source = postgres(options.sourceUrl, { max: 1 });
  const target = postgres(options.targetUrl, { max: 1 });

  try {
    await assertDistinctDatabases(source, target);

    const sourceMigrationCount = await source.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      return await validateSourceDatabase(tx, migrationsDir);
    });

    const { targetMigrationCount, targetPublicTables } = await target.begin(
      async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        const validated = await validateTargetDatabase(tx, migrationsDir);
        return {
          targetMigrationCount: validated.v011Count,
          targetPublicTables: validated.publicTables,
        };
      },
    );

    const plan = await source.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      return await buildUpgradePlan(tx, targetPublicTables, executedAt);
    });

    let tableCounts: Record<string, number>;
    if (dryRun) {
      await target.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await introspectAllTargetColumns(tx, plan);
      });
      tableCounts = {};
      for (const tableName of CORE_INSERT_ORDER) {
        tableCounts[tableName] = plan.tables[tableName]?.length ?? 0;
      }
      tableCounts["domain_storage_objects"] = estimateStorageObjectsCount(plan);
      tableCounts["domain_resource_counters"] = 3;
      if (plan.gateway.detected) {
        tableCounts["llm_providers"] = plan.gateway.providers.length;
        tableCounts["llm_usage"] = plan.gateway.usage.length;
        tableCounts["llm_quotas"] = plan.gateway.quotas.length;
        tableCounts["llm_gateway_domain_settings"] =
          plan.gateway.domainSettingsRow ? 1 : 0;
        tableCounts["llm_gateway_model_aliases"] =
          plan.gateway.modelAliasRows.length;
      }
    } else {
      tableCounts = await executeTargetTransaction(target, plan);
    }

    return {
      dryRun,
      executedAt,
      defaultDomainId: DEFAULT_DOMAIN_ID,
      defaultDomainSlug: "main",
      defaultDomainOwnerId: plan.defaultDomainOwnerId,
      sourceMigrationCount,
      targetMigrationCount,
      tableCounts,
      archivedSummary: plan.archivedSummary,
      gateway: {
        detected: plan.gateway.detected,
        copiedProviders: plan.gateway.providers.length,
        copiedUsage: plan.gateway.usage.length,
        copiedQuotas: plan.gateway.quotas.length,
        backfilledDomainSettings: plan.gateway.domainSettingsRow ? 1 : 0,
        backfilledModelAliases: plan.gateway.modelAliasRows.length,
      },
    };
  } finally {
    await Promise.allSettled([
      source.end({ timeout: 5 }),
      target.end({ timeout: 5 }),
    ]);
  }
}
