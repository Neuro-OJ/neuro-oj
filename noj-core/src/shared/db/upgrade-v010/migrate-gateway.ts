/**
 * `noj-llm-gateway` 历史数据迁移与模型执行权配置回填。
 *
 * 生产/开发单库部署时 `llm_providers` / `llm_usage` / `llm_quotas` 与 Core 同库；
 * 若源库与目标库分离部署网关表，则按 `detected = false` 跳过数据复制。
 *
 * 默认模型（`system_settings.llm_default_*`）与模型别名在 v0.10.6 一律存放在 Core 库，
 * 而 v0.11 Gateway 只读自有的 `llm_gateway_domain_settings` / `llm_gateway_model_aliases`。
 * 目标 Core 库内有 Gateway 表时随 Core 事务写入；否则必须提供独立 Gateway 库连接串，
 * 由 {@link applyStandaloneGatewaySettings} 写入并逐行读回校验。
 */

import {
  countTableRows,
  getTargetInsertColumns,
  insertRowsBatched,
  type JsonParamSerializer,
  listPublicTables,
  type PgExecutor,
  readAllRows,
} from "./copy-helpers.ts";
import { DEFAULT_DOMAIN_ID } from "./transform.ts";
import { type GatewayMigrationSummary, UpgradeV010Error } from "./types.ts";

/** Gateway 模型执行权表（v0.11 Gateway 迁移 `flat_forge` 创建）。 */
const GATEWAY_SETTINGS_TABLES = [
  "llm_gateway_domain_settings",
  "llm_gateway_model_aliases",
] as const;

const SOURCE_GATEWAY_TABLES = [
  "llm_providers",
  "llm_usage",
  "llm_quotas",
] as const;

const TARGET_GATEWAY_TABLES = [
  "llm_providers",
  "llm_usage",
  "llm_quotas",
  "llm_gateway_domain_settings",
  "llm_gateway_model_aliases",
] as const;

export interface GatewaySourcePlan {
  /** 源库与目标库均含 Gateway 数据表：随 Core 事务复制 providers/usage/quotas。 */
  detected: boolean;
  /** 目标 Core 库含 Gateway 模型执行权表：默认模型与别名随 Core 事务写入。 */
  settingsInTarget: boolean;
  providers: Record<string, unknown>[];
  usage: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
  domainSettingsRow: {
    domain_id: string;
    provider_id: string;
    model: string;
    revision: number;
    updated_at: string;
    updated_by: string;
  } | null;
  modelAliasRows: Array<{
    domain_id: string;
    alias: string;
    provider_id: string;
    model: string;
    description: string;
    revision: number;
    updated_at: string;
    updated_by: string;
  }>;
}

/** 在只读源事务中探测并规划同库 Gateway 迁移数据。 */
export async function planGatewayMigration(
  sourceTx: PgExecutor,
  targetPublicTables: ReadonlySet<string>,
  domainLlmSetting: {
    domain_id: string;
    provider_id: string | null;
    model: string | null;
    updated_at: string;
  } | null,
  coreAliases: readonly Record<string, unknown>[],
  ownerId: string,
): Promise<GatewaySourcePlan> {
  const sourceTables = new Set(await listPublicTables(sourceTx));
  const hasAllSource = SOURCE_GATEWAY_TABLES.every((t) => sourceTables.has(t));
  const hasAllTarget = TARGET_GATEWAY_TABLES.every((t) =>
    targetPublicTables.has(t)
  );
  const settingsInTarget = GATEWAY_SETTINGS_TABLES.every((t) =>
    targetPublicTables.has(t)
  );

  const domainSettingsRow =
    domainLlmSetting && domainLlmSetting.provider_id && domainLlmSetting.model
      ? {
        domain_id: DEFAULT_DOMAIN_ID,
        provider_id: domainLlmSetting.provider_id,
        model: domainLlmSetting.model,
        revision: 1,
        updated_at: domainLlmSetting.updated_at,
        updated_by: ownerId,
      }
      : null;

  const modelAliasRows = coreAliases
    .filter((row) => String(row.alias ?? "") !== "default")
    .map((row) => ({
      domain_id: DEFAULT_DOMAIN_ID,
      alias: String(row.alias),
      provider_id: String(row.provider_id),
      model: String(row.model),
      description: String(row.description ?? ""),
      revision: Math.max(1, Number(row.revision ?? 1)),
      updated_at: String(row.updated_at),
      updated_by: row.updated_by ? String(row.updated_by) : ownerId,
    }));

  const settingsOnly = {
    detected: false,
    settingsInTarget,
    providers: [],
    usage: [],
    quotas: [],
    domainSettingsRow,
    modelAliasRows,
  };

  if (!hasAllSource) {
    return settingsOnly;
  }

  if (!hasAllTarget) {
    let sourceGatewayRowTotal = 0;
    for (const table of SOURCE_GATEWAY_TABLES) {
      sourceGatewayRowTotal += await countTableRows(sourceTx, table);
    }
    if (sourceGatewayRowTotal > 0) {
      const missingTarget = TARGET_GATEWAY_TABLES.filter(
        (t) => !targetPublicTables.has(t),
      );
      throw new UpgradeV010Error(
        "TARGET_INVALID_SCHEMA",
        `源库存在非空 LLM Gateway 表，但目标库缺少 Gateway v0.11 表 (${
          missingTarget.join(", ")
        })；请先对目标库执行 noj-llm-gateway 迁移（deno task db:migrate --schema-only）`,
        { missingTarget },
      );
    }
    return settingsOnly;
  }

  const [rawProviders, rawUsage, rawQuotas] = await Promise.all([
    readAllRows(sourceTx, "llm_providers", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "llm_usage", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "llm_quotas", "ORDER BY created_at ASC, id ASC"),
  ]);

  const providers = rawProviders.map((row) => ({
    ...row,
    domain_id: DEFAULT_DOMAIN_ID,
    revision: Number(row.revision ?? 1),
  }));

  const usage = rawUsage.map((row) => ({
    ...row,
    domain_id: DEFAULT_DOMAIN_ID,
    principal_type: "user",
    principal_id: null,
  }));

  const quotas = rawQuotas.map((row) => ({
    ...row,
    domain_id: row.scope_type === "global" ? "" : DEFAULT_DOMAIN_ID,
    revision: Number(row.revision ?? 1),
  }));

  return {
    detected: true,
    settingsInTarget,
    providers,
    usage,
    quotas,
    domainSettingsRow,
    modelAliasRows,
  };
}

/** 源库存在需迁往 Gateway 的默认模型或别名，但目标 Core 库内没有 Gateway 表。 */
export function requiresStandaloneGatewayTransfer(
  plan: GatewaySourcePlan,
): boolean {
  return !plan.settingsInTarget &&
    (plan.domainSettingsRow !== null || plan.modelAliasRows.length > 0);
}

type CoreTxGatewaySummary = Omit<GatewayMigrationSummary, "standalone">;

/** 在同一个目标事务内写入已规划的 Gateway 数据并返回摘要。 */
export async function applyGatewayMigration(
  targetTx: PgExecutor,
  plan: GatewaySourcePlan,
  serializeJson: JsonParamSerializer,
): Promise<CoreTxGatewaySummary> {
  const settings = plan.settingsInTarget
    ? await applySettingsRows(targetTx, plan, serializeJson)
    : { domainSettings: 0, modelAliases: 0 };
  if (!plan.detected) {
    return {
      detected: false,
      copiedProviders: 0,
      copiedUsage: 0,
      copiedQuotas: 0,
      backfilledDomainSettings: settings.domainSettings,
      backfilledModelAliases: settings.modelAliases,
    };
  }

  const [providerCols, usageCols, quotaCols] = await Promise.all([
    getTargetInsertColumns(targetTx, "llm_providers"),
    getTargetInsertColumns(targetTx, "llm_usage"),
    getTargetInsertColumns(targetTx, "llm_quotas"),
  ]);

  const copiedProviders = await insertRowsBatched(
    targetTx,
    "llm_providers",
    providerCols,
    plan.providers,
    serializeJson,
  );
  const copiedUsage = await insertRowsBatched(
    targetTx,
    "llm_usage",
    usageCols,
    plan.usage,
    serializeJson,
  );
  const copiedQuotas = await insertRowsBatched(
    targetTx,
    "llm_quotas",
    quotaCols,
    plan.quotas,
    serializeJson,
  );

  return {
    detected: true,
    copiedProviders,
    copiedUsage,
    copiedQuotas,
    backfilledDomainSettings: settings.domainSettings,
    backfilledModelAliases: settings.modelAliases,
  };
}

async function applySettingsRows(
  tx: PgExecutor,
  plan: GatewaySourcePlan,
  serializeJson: JsonParamSerializer,
): Promise<{ domainSettings: number; modelAliases: number }> {
  const [domainSettingsCols, modelAliasCols] = await Promise.all([
    getTargetInsertColumns(tx, "llm_gateway_domain_settings"),
    getTargetInsertColumns(tx, "llm_gateway_model_aliases"),
  ]);
  const domainSettings = plan.domainSettingsRow
    ? await insertRowsBatched(
      tx,
      "llm_gateway_domain_settings",
      domainSettingsCols,
      [plan.domainSettingsRow],
      serializeJson,
    )
    : 0;
  const modelAliases = await insertRowsBatched(
    tx,
    "llm_gateway_model_aliases",
    modelAliasCols,
    plan.modelAliasRows,
    serializeJson,
  );
  return { domainSettings, modelAliases };
}

interface GatewaySettingRow {
  provider_id: string | null;
  model: string | null;
}

interface GatewayAliasRow {
  alias: string;
  provider_id: string;
  model: string;
}

/** 比对独立 Gateway 库现有/写入后的配置与计划，返回差异描述（不含凭据）。 */
async function diffStandaloneSettings(
  tx: PgExecutor,
  plan: GatewaySourcePlan,
  requirePresent: boolean,
): Promise<string[]> {
  const problems: string[] = [];
  const settingRows = await tx<GatewaySettingRow[]>`
    SELECT provider_id, model FROM llm_gateway_domain_settings
    WHERE domain_id = ${DEFAULT_DOMAIN_ID}
  `;
  const expected = plan.domainSettingsRow;
  if (expected) {
    const actual = settingRows[0];
    if (!actual) {
      if (requirePresent) problems.push("默认模型未写入");
    } else if (
      actual.provider_id !== expected.provider_id ||
      actual.model !== expected.model
    ) {
      problems.push(
        `默认模型已存在且不一致（现有 ${actual.provider_id}/${actual.model}，计划 ${expected.provider_id}/${expected.model}）`,
      );
    }
  }
  if (plan.modelAliasRows.length > 0) {
    const aliasRows = await tx<GatewayAliasRow[]>`
      SELECT alias, provider_id, model FROM llm_gateway_model_aliases
      WHERE domain_id = ${DEFAULT_DOMAIN_ID}
    `;
    const byAlias = new Map(aliasRows.map((r) => [r.alias, r]));
    for (const row of plan.modelAliasRows) {
      const actual = byAlias.get(row.alias);
      if (!actual) {
        if (requirePresent) problems.push(`别名 ${row.alias} 未写入`);
      } else if (
        actual.provider_id !== row.provider_id || actual.model !== row.model
      ) {
        problems.push(
          `别名 ${row.alias} 已存在且不一致（现有 ${actual.provider_id}/${actual.model}，计划 ${row.provider_id}/${row.model}）`,
        );
      }
    }
  }
  return problems;
}

/**
 * 向独立部署的 Gateway 库转移默认模型与别名，并在同一事务内逐行读回校验。
 *
 * `dryRun=true` 时只读校验 schema 与冲突；写入使用 `ON CONFLICT DO NOTHING`，
 * 与计划完全一致的既有行视为幂等成功，不一致则拒绝以免覆盖运维手工配置。
 */
export async function applyStandaloneGatewaySettings(
  gatewaySql: PgExecutor,
  plan: GatewaySourcePlan,
  dryRun: boolean,
): Promise<NonNullable<GatewayMigrationSummary["standalone"]>> {
  const tables = new Set(await listPublicTables(gatewaySql));
  const missing = GATEWAY_SETTINGS_TABLES.filter((t) => !tables.has(t));
  if (missing.length > 0) {
    throw new UpgradeV010Error(
      "GATEWAY_TARGET_INVALID",
      `独立 Gateway 库缺少 v0.11 表 (${
        missing.join(", ")
      })；请先对该库执行 noj-llm-gateway 的 v0.11 迁移`,
      { missingTables: missing },
    );
  }
  const conflicts = await diffStandaloneSettings(gatewaySql, plan, false);
  if (conflicts.length > 0) {
    throw new UpgradeV010Error(
      "GATEWAY_TARGET_INVALID",
      `独立 Gateway 库已有与源库不一致的模型配置：${conflicts.join("；")}`,
      { conflicts },
    );
  }
  const domainSettings = plan.domainSettingsRow ? 1 : 0;
  const modelAliases = plan.modelAliasRows.length;
  if (dryRun) {
    return { domainSettings, modelAliases, verified: false };
  }

  if (plan.domainSettingsRow) {
    const r = plan.domainSettingsRow;
    await gatewaySql`
      INSERT INTO llm_gateway_domain_settings
        (domain_id, provider_id, model, revision, updated_at, updated_by)
      VALUES (${r.domain_id}, ${r.provider_id}, ${r.model}, ${r.revision},
        ${r.updated_at}, ${r.updated_by})
      ON CONFLICT (domain_id) DO NOTHING
    `;
  }
  for (const r of plan.modelAliasRows) {
    await gatewaySql`
      INSERT INTO llm_gateway_model_aliases
        (domain_id, alias, provider_id, model, description, revision,
         updated_at, updated_by)
      VALUES (${r.domain_id}, ${r.alias}, ${r.provider_id}, ${r.model},
        ${r.description}, ${r.revision}, ${r.updated_at}, ${r.updated_by})
      ON CONFLICT (domain_id, alias) DO NOTHING
    `;
  }
  const verifyProblems = await diffStandaloneSettings(gatewaySql, plan, true);
  if (verifyProblems.length > 0) {
    throw new UpgradeV010Error(
      "GATEWAY_VERIFY_FAILED",
      `独立 Gateway 库模型配置写入后校验失败：${verifyProblems.join("；")}`,
      { problems: verifyProblems },
    );
  }
  return { domainSettings, modelAliases, verified: true };
}
