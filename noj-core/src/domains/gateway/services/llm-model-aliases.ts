/**
 * LLM 模型别名：别名 → (gateway Provider, 真实模型名) 的管理与解析。
 *
 * 题目 `llm_config.models` 只引用别名；评测时 core 把别名解析为 Provider + 真实
 * 模型并写入 eval_token 的 `model_map`，gateway 转发前换成真实模型名。
 * `default` 为保留别名，不入表，恒等于平台默认（`llm_default_provider_id` +
 * `llm_default_model`）。别名每次从 DB 读取，不做进程内缓存（多副本一致）。
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { llmModelAliases, problems } from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  LLM_DEFAULT_MODEL_ALIAS,
  LLM_MODEL_ALIAS_PATTERN,
  type LlmConfig,
} from "../../catalog/index.ts";
import { getLlmPlatformDefault, getLlmProviderById } from "./llm.ts";

/** 别名数量上限（防止滥用）。 */
const MAX_ALIASES = 32;

/** 别名表行（管理端完整视图）。 */
export interface LlmModelAlias {
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  updated_at: string;
}

/** 新增 / 更新别名的输入。 */
export interface LlmModelAliasInput {
  provider_id: string;
  model: string;
  description?: string;
}

/** 已解析的题目模型集合：全部别名同属一个 Provider。 */
export interface ResolvedLlmModels {
  provider_id: string;
  models: { alias: string; model: string }[];
}

/** 规范化题目的别名列表：缺省为 `["default"]`。 */
export function normalizeLlmModels(
  llm: Pick<LlmConfig, "models"> | null | undefined,
): string[] {
  return llm?.models && llm.models.length > 0
    ? llm.models
    : [LLM_DEFAULT_MODEL_ALIAS];
}

/** 题目只用平台默认（单个 `default`）：此时 token 与旧版完全一致。 */
export function isDefaultOnly(models: { alias: string }[]): boolean {
  return models.length === 1 && models[0].alias === LLM_DEFAULT_MODEL_ALIAS;
}

/** 列出全部别名（按名称排序）。 */
export async function listLlmModelAliases(): Promise<LlmModelAlias[]> {
  const rows = await getDb().select().from(llmModelAliases).orderBy(
    llmModelAliases.alias,
  );
  return rows.map(toView);
}

function toView(row: typeof llmModelAliases.$inferSelect): LlmModelAlias {
  return {
    alias: row.alias,
    provider_id: row.provider_id,
    model: row.model,
    description: row.description,
    updated_at: row.updated_at,
  };
}

/** 新增或更新别名；Provider 须在 gateway 存在。 */
export async function upsertLlmModelAlias(
  alias: string,
  input: LlmModelAliasInput,
  actorId: string,
): Promise<LlmModelAlias> {
  if (alias === LLM_DEFAULT_MODEL_ALIAS) {
    throw new BadRequestError(
      "default 是保留别名，请在「平台默认 Provider / 模型」中配置",
    );
  }
  if (!LLM_MODEL_ALIAS_PATTERN.test(alias)) {
    throw new BadRequestError(
      "别名须以小写字母开头，仅含小写字母、数字、_、-，且不超过 32 字符",
    );
  }
  const providerId = String(input.provider_id ?? "").trim();
  const model = String(input.model ?? "").trim();
  const description = String(input.description ?? "").trim();
  if (!providerId || !model) {
    throw new BadRequestError("provider_id 与 model 均为必填");
  }
  if (model.length > 128) throw new BadRequestError("模型名不能超过 128 字符");
  if (description.length > 80) {
    throw new BadRequestError("说明不能超过 80 字符");
  }
  await getLlmProviderById(providerId); // 不存在 → LlmGatewayError(404)

  const db = getDb();
  const existing = await db.select({ alias: llmModelAliases.alias }).from(
    llmModelAliases,
  );
  if (
    existing.length >= MAX_ALIASES && !existing.some((r) => r.alias === alias)
  ) {
    throw new BadRequestError(`别名数量不能超过 ${MAX_ALIASES} 个`);
  }
  const now = new Date().toISOString();
  const [row] = await db.insert(llmModelAliases).values({
    alias,
    provider_id: providerId,
    model,
    description,
    updated_at: now,
    updated_by: actorId,
  }).onConflictDoUpdate({
    target: llmModelAliases.alias,
    set: {
      provider_id: providerId,
      model,
      description,
      updated_at: now,
      updated_by: actorId,
    },
  }).returning();
  return toView(row);
}

/** 引用某别名的题目 ID 列表（`llm_config.models` 包含该别名）。 */
export async function listProblemsUsingAlias(
  alias: string,
): Promise<string[]> {
  const rows = await getDb().select({ id: problems.id }).from(problems).where(
    sql`${problems.llm_config} -> 'models' @> ${
      JSON.stringify([alias])
    }::jsonb`,
  );
  return rows.map((r) => r.id);
}

/** 删除别名；返回是否存在。是否允许删除被引用的别名由调用方决定。 */
export async function deleteLlmModelAlias(alias: string): Promise<boolean> {
  const rows = await getDb().delete(llmModelAliases).where(
    eq(llmModelAliases.alias, alias),
  ).returning({ alias: llmModelAliases.alias });
  return rows.length > 0;
}

/**
 * 把别名列表解析为 Provider + 真实模型；全部别名须属于同一 Provider。
 *
 * @throws {BadRequestError} 别名未配置 / 平台默认未配置 / 跨 Provider
 */
export async function resolveLlmModels(
  aliases: string[],
): Promise<ResolvedLlmModels> {
  const rows = new Map(
    (await getDb().select().from(llmModelAliases)).map((r) => [r.alias, r]),
  );
  const models: { alias: string; model: string }[] = [];
  const providers = new Set<string>();
  for (const alias of aliases) {
    if (alias === LLM_DEFAULT_MODEL_ALIAS) {
      const platform = getLlmPlatformDefault();
      if (!platform) {
        throw new BadRequestError(
          "平台未配置默认 LLM Provider / 模型，无法评测 LLM 题",
        );
      }
      providers.add(platform.provider_id);
      models.push({ alias, model: platform.model });
      continue;
    }
    const row = rows.get(alias);
    if (!row) {
      throw new BadRequestError(`题目引用的模型别名「${alias}」未配置`);
    }
    providers.add(row.provider_id);
    models.push({ alias, model: row.model });
  }
  if (providers.size !== 1) {
    throw new BadRequestError(
      `所选模型别名（${
        aliases.join("、")
      }）属于不同 Provider，同一道题只能使用同一 Provider 的模型`,
    );
  }
  return { provider_id: [...providers][0], models };
}

/**
 * 题目保存校验：引用的别名存在且同属一个 Provider。
 *
 * @param allowUnknown 题包导入时为 true：别名尚未在本部署定义时放行（返回
 * 警告文案），只对**已存在**的别名检查跨 Provider。
 * @returns 警告文案列表（仅 allowUnknown 时可能非空）
 */
export async function assertLlmModelsValid(
  llm: LlmConfig,
  opts: { allowUnknown?: boolean } = {},
): Promise<string[]> {
  if (!llm.models) return []; // 缺省 default：提交路径兜底
  if (!opts.allowUnknown) {
    await resolveLlmModels(llm.models);
    return [];
  }
  const known = new Map(
    (await getDb().select().from(llmModelAliases)).map((r) => [r.alias, r]),
  );
  const warnings: string[] = [];
  const providers = new Set<string>();
  for (const alias of llm.models) {
    if (alias === LLM_DEFAULT_MODEL_ALIAS) continue;
    const row = known.get(alias);
    if (!row) {
      warnings.push(`模型别名「${alias}」尚未在本平台配置，评测前请先配置`);
    } else providers.add(row.provider_id);
  }
  if (providers.size > 1) {
    throw new BadRequestError(
      `所选模型别名（${
        llm.models.join("、")
      }）属于不同 Provider，同一道题只能使用同一 Provider 的模型`,
    );
  }
  return warnings;
}
