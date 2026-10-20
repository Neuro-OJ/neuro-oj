/** 使用域模型别名：能力名称在题目版本中声明，Provider 与真实模型由执行域决定。 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { llmModelAliases } from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import {
  LLM_DEFAULT_MODEL_ALIAS,
  LLM_MODEL_ALIAS_PATTERN,
  type LlmConfig,
} from "../../../modules/problems/index.ts";
import { getLlmProviderById } from "./llm.ts";
import { getDomainLlmDefault } from "./domain-default.ts";

const MAX_ALIASES = 32;
/** 管理视图仅属于指定使用域。 */
export interface LlmModelAlias {
  domain_id: string;
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  revision: number;
  updated_at: string;
}
/** 别名配置输入。 */
export interface LlmModelAliasInput {
  provider_id: string;
  model: string;
  description?: string;
}
/** 一个使用域内的模型集合仍属于同一 Provider。 */
export interface ResolvedLlmModels {
  provider_id: string;
  models: { alias: string; model: string }[];
}
/** 缺省能力声明使用 default 别名。 */
export function normalizeLlmModels(
  llm: Pick<LlmConfig, "models"> | null | undefined,
): string[] {
  return llm?.models?.length ? llm.models : [LLM_DEFAULT_MODEL_ALIAS];
}
/** default-only 保留单个真实模型的协议形态。 */
export function isDefaultOnly(models: { alias: string }[]): boolean {
  return models.length === 1 && models[0].alias === LLM_DEFAULT_MODEL_ALIAS;
}
function toView(row: typeof llmModelAliases.$inferSelect): LlmModelAlias {
  return {
    domain_id: row.domain_id,
    alias: row.alias,
    provider_id: row.provider_id,
    model: row.model,
    description: row.description,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}
/** 旧无域管理入口明确固定 main；其他域必须显式传入目标域。 */
export async function listLlmModelAliases(
  domainId = DEFAULT_DOMAIN_ID,
  executor: Executor = getDb(),
): Promise<LlmModelAlias[]> {
  return (await executor.select().from(llmModelAliases).where(
    eq(llmModelAliases.domain_id, domainId),
  )
    .orderBy(llmModelAliases.alias)).map(toView);
}
/** 出题者只读取本域能力名称与说明；调用方负责当前作者权限。 */
export async function listLlmModelAliasCapabilities(domainId: string) {
  const rows = await getDb().select({
    alias: llmModelAliases.alias,
    description: llmModelAliases.description,
  })
    .from(llmModelAliases).where(eq(llmModelAliases.domain_id, domainId))
    .orderBy(llmModelAliases.alias);
  return [{
    alias: LLM_DEFAULT_MODEL_ALIAS,
    description: "使用当前工作空间默认模型",
  }, ...rows];
}
/** 资源 revision 由调用方读取，创建为 0，修改原子比较后递增。 */
export async function upsertLlmModelAlias(
  alias: string,
  input: LlmModelAliasInput,
  actorId: string,
  domainId = DEFAULT_DOMAIN_ID,
  revision = 0,
  executor: Executor = getDb(),
): Promise<LlmModelAlias> {
  if (alias === LLM_DEFAULT_MODEL_ALIAS) {
    throw new BadRequestError(
      "default 是保留别名，请在本域默认 Provider / 模型中配置",
    );
  }
  if (!LLM_MODEL_ALIAS_PATTERN.test(alias)) {
    throw new BadRequestError(
      "别名须以小写字母开头，仅含小写字母、数字、_、-，且不超过 32 字符",
    );
  }
  const providerId = String(input.provider_id ?? "").trim(),
    model = String(input.model ?? "").trim(),
    description = String(input.description ?? "").trim();
  if (!providerId || !model) {
    throw new BadRequestError("provider_id 与 model 均为必填");
  }
  if (model.length > 128) throw new BadRequestError("模型名不能超过 128 字符");
  if (description.length > 80) {
    throw new BadRequestError("说明不能超过 80 字符");
  }
  const provider = await getLlmProviderById(providerId, domainId);
  if (provider.domain_id !== domainId) {
    throw new BadRequestError(
      "Provider 不属于当前工作空间",
      "LLM_DOMAIN_MISMATCH",
    );
  }
  const fields = {
    provider_id: providerId,
    model,
    description,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  };
  let row: typeof llmModelAliases.$inferSelect | undefined;
  if (revision === 0) {
    const existing = await executor.select({ alias: llmModelAliases.alias })
      .from(llmModelAliases)
      .where(eq(llmModelAliases.domain_id, domainId));
    if (
      existing.length >= MAX_ALIASES && !existing.some((r) => r.alias === alias)
    ) throw new BadRequestError(`别名数量不能超过 ${MAX_ALIASES} 个`);
    [row] = await executor.insert(llmModelAliases).values({
      domain_id: domainId,
      alias,
      revision: 1,
      ...fields,
    })
      .onConflictDoUpdate({
        target: [llmModelAliases.domain_id, llmModelAliases.alias],
        set: { ...fields, revision: sql`${llmModelAliases.revision}+1` },
        setWhere: eq(llmModelAliases.revision, revision),
      }).returning();
  } else {
    [row] = await executor.update(llmModelAliases).set({
      ...fields,
      revision: sql`${llmModelAliases.revision}+1`,
    })
      .where(
        and(
          eq(llmModelAliases.domain_id, domainId),
          eq(llmModelAliases.alias, alias),
          eq(llmModelAliases.revision, revision),
        ),
      ).returning();
  }
  if (!row) {
    throw new ConflictError("模型别名 revision 已变化", "REVISION_CONFLICT");
  }
  return toView(row);
}
/** 当前使用域作答版本中声明此能力的题目，不读取其他域资源或 Provider。 */
export async function listProblemsUsingAlias(
  alias: string,
  domainId = DEFAULT_DOMAIN_ID,
  executor: Executor = getDb(),
): Promise<string[]> {
  const result = await executor.execute(
    sql`SELECT b.problem_id AS id FROM domain_problem_bindings b
    JOIN problems p ON p.id=b.problem_id JOIN problem_versions v ON v.id=
      CASE WHEN b.effective_version_mode='exact' THEN b.required_version_id ELSE p.latest_version_id END
    WHERE b.domain_id=${domainId} AND v.content->'llm_config'->'models' @> ${
      JSON.stringify([alias])
    }::jsonb`,
  );
  return unwrapRows<{ id: string }>(result as never).map((row) => row.id);
}
/** 删除只匹配目标域及当前资源 revision。 */
export async function deleteLlmModelAlias(
  alias: string,
  domainId = DEFAULT_DOMAIN_ID,
  revision = 0,
  executor: Executor = getDb(),
): Promise<boolean> {
  const condition = and(
    eq(llmModelAliases.domain_id, domainId),
    eq(llmModelAliases.alias, alias),
  );
  const rows = await executor.delete(llmModelAliases).where(
    and(condition, eq(llmModelAliases.revision, revision)),
  )
    .returning({ alias: llmModelAliases.alias });
  if (
    !rows.length &&
    (await executor.select({ alias: llmModelAliases.alias }).from(
      llmModelAliases,
    ).where(condition)).length
  ) {
    throw new ConflictError("模型别名 revision 已变化", "REVISION_CONFLICT");
  }
  return rows.length > 0;
}
/** 受理时解析执行域配置；不借源域或平台 Provider，重派由冻结快照提供模型。 */
export async function resolveLlmModels(
  aliases: string[],
  domainId = DEFAULT_DOMAIN_ID,
): Promise<ResolvedLlmModels> {
  const rows = new Map(
    (await listLlmModelAliases(domainId)).map((r) => [r.alias, r]),
  );
  const models: { alias: string; model: string }[] = [],
    providers = new Set<string>();
  for (const alias of aliases) {
    const row = alias === LLM_DEFAULT_MODEL_ALIAS
      ? await getDomainLlmDefault(domainId)
      : rows.get(alias);
    if (!row) {
      throw new BadRequestError(
        `当前工作空间尚未配置模型别名「${alias}」`,
        "DOMAIN_LLM_NOT_CONFIGURED",
      );
    }
    providers.add(row.provider_id);
    models.push({ alias, model: row.model });
  }
  if (providers.size !== 1) {
    throw new BadRequestError(
      "当前工作空间的模型别名属于不同 Provider，同一次评测必须使用同一 Provider",
    );
  }
  return { provider_id: [...providers][0], models };
}
/** 发布声明能力而不绑定本部署的 Provider；题包导入可列出未配置能力供管理员准备。 */
export async function assertLlmModelsValid(
  llm: LlmConfig,
  opts: { allowUnknown?: boolean; domainId?: string } = {},
): Promise<string[]> {
  if (!llm.models || !opts.allowUnknown) return [];
  const known = new Set(
    (await listLlmModelAliasCapabilities(opts.domainId ?? DEFAULT_DOMAIN_ID))
      .map((row) => row.alias),
  );
  return llm.models.filter((alias) => !known.has(alias)).map((alias) =>
    `模型别名「${alias}」尚未在使用域配置，评测前请先配置`
  );
}
