/**
 * 同库 `noj-llm-gateway` 历史数据迁移与配置回填。
 *
 * 生产/开发单库部署时 `llm_providers` / `llm_usage` / `llm_quotas` 与 Core 同库；
 * 若源库与目标库分离部署网关表，则按 `detected = false` 跳过并保留独立迁移路径。
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
  detected: boolean;
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

  if (!hasAllSource) {
    return {
      detected: false,
      providers: [],
      usage: [],
      quotas: [],
      domainSettingsRow: null,
      modelAliasRows: [],
    };
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
        })；请先对目标库执行 noj-llm-gateway 迁移`,
        { missingTarget },
      );
    }
    return {
      detected: false,
      providers: [],
      usage: [],
      quotas: [],
      domainSettingsRow: null,
      modelAliasRows: [],
    };
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

  return {
    detected: true,
    providers,
    usage,
    quotas,
    domainSettingsRow,
    modelAliasRows,
  };
}

/** 在同一个目标事务内写入已规划的 Gateway 数据并返回摘要。 */
export async function applyGatewayMigration(
  targetTx: PgExecutor,
  plan: GatewaySourcePlan,
  serializeJson: JsonParamSerializer,
): Promise<GatewayMigrationSummary> {
  if (!plan.detected) {
    return {
      detected: false,
      copiedProviders: 0,
      copiedUsage: 0,
      copiedQuotas: 0,
      backfilledDomainSettings: 0,
      backfilledModelAliases: 0,
    };
  }

  const [
    providerCols,
    usageCols,
    quotaCols,
    domainSettingsCols,
    modelAliasCols,
  ] = await Promise.all([
    getTargetInsertColumns(targetTx, "llm_providers"),
    getTargetInsertColumns(targetTx, "llm_usage"),
    getTargetInsertColumns(targetTx, "llm_quotas"),
    getTargetInsertColumns(targetTx, "llm_gateway_domain_settings"),
    getTargetInsertColumns(targetTx, "llm_gateway_model_aliases"),
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
  const backfilledDomainSettings = plan.domainSettingsRow
    ? await insertRowsBatched(
      targetTx,
      "llm_gateway_domain_settings",
      domainSettingsCols,
      [plan.domainSettingsRow],
      serializeJson,
    )
    : 0;
  const backfilledModelAliases = await insertRowsBatched(
    targetTx,
    "llm_gateway_model_aliases",
    modelAliasCols,
    plan.modelAliasRows,
    serializeJson,
  );

  return {
    detected: true,
    copiedProviders,
    copiedUsage,
    copiedQuotas,
    backfilledDomainSettings,
    backfilledModelAliases,
  };
}
