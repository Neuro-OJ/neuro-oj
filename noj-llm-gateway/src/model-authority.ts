/**
 * Gateway 内的使用域模型权威。
 *
 * Core 只保存题目声明的能力名与评测冻结快照；默认模型、别名到真实模型
 * 的解析，以及 Provider 归属/启用状态均在这里完成。这样受理路径不会再
 * 读取 Core 的第二份可写模型配置。
 */
import type { Db } from "./db.ts";
import { getProviderById } from "./providers.ts";

const DEFAULT_ALIAS = "default";
const MAX_ALIASES = 32;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ModelAliasInput {
  provider_id: string;
  model: string;
  description?: string;
}

export interface ModelAliasView {
  domain_id: string;
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  revision: number;
  updated_at: string;
  updated_by: string;
}

export interface DomainModelSettingsView {
  domain_id: string;
  provider_id: string | null;
  model: string | null;
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ResolvedModelSelection {
  provider_id: string;
  models: { alias: string; model: string }[];
}

export class ModelAuthorityError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ModelAuthorityError";
  }
}

interface ModelAliasRow {
  domain_id: string;
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  revision: number;
  updated_at: string;
  updated_by: string;
}

interface SettingsRow {
  domain_id: string;
  provider_id: string | null;
  model: string | null;
  revision: number;
  updated_at: string;
  updated_by: string;
}

function now(): string {
  return new Date().toISOString();
}

function toAliasView(row: ModelAliasRow): ModelAliasView {
  return {
    domain_id: row.domain_id,
    alias: row.alias,
    provider_id: row.provider_id,
    model: row.model,
    description: row.description,
    revision: Number(row.revision),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function toSettingsView(row: SettingsRow): DomainModelSettingsView {
  return {
    domain_id: row.domain_id,
    provider_id: row.provider_id,
    model: row.model,
    revision: Number(row.revision),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ModelAuthorityError(400, "invalid_revision");
  }
}

function validateAlias(alias: string): void {
  if (alias === DEFAULT_ALIAS) {
    throw new ModelAuthorityError(400, "reserved_alias");
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new ModelAuthorityError(400, "invalid_alias");
  }
}

function validateAliasInput(input: ModelAliasInput): {
  providerId: string;
  model: string;
  description: string;
} {
  const providerId = String(input.provider_id ?? "").trim();
  const model = String(input.model ?? "").trim();
  const description = String(input.description ?? "").trim();
  if (!providerId || !model) {
    throw new ModelAuthorityError(400, "missing_required_fields");
  }
  if (model.length > 128) {
    throw new ModelAuthorityError(400, "model_too_long");
  }
  if (description.length > 80) {
    throw new ModelAuthorityError(400, "description_too_long");
  }
  return { providerId, model, description };
}

function validateSettingsInput(input: {
  provider_id: string | null;
  model: string | null;
}): { providerId: string | null; model: string | null } {
  const providerId = input.provider_id === null
    ? null
    : String(input.provider_id ?? "").trim();
  const model = input.model === null ? null : String(input.model ?? "").trim();
  if ((providerId === null) !== (model === null) || !providerId || !model) {
    throw new ModelAuthorityError(400, "invalid_default_selection");
  }
  if (model !== null && model.length > 128) {
    throw new ModelAuthorityError(400, "model_too_long");
  }
  return { providerId, model };
}

async function requireEnabledProvider(
  db: Db,
  providerId: string,
  domainId: string,
): Promise<void> {
  const provider = await getProviderById(db, providerId, domainId);
  if (!provider) {
    // 跨域/不存在的 Provider 一律 404：不通过 400/404 差异泄露其他域资源存在性
    // （E2E「学校管理员不能选择其他域 Provider」合同要求 404）。
    throw new ModelAuthorityError(404, "provider_not_found");
  }
  if (!provider.enabled) {
    // 本域 Provider 已停用是可由管理员修复的状态，保留 400 语义。
    throw new ModelAuthorityError(400, "provider_not_found");
  }
}

/** 读取域默认模型；不存在的域配置以 revision 0 的空选择表示。 */
export async function readDomainModelSettings(
  db: Db,
  domainId: string,
): Promise<DomainModelSettingsView> {
  const rows = await db<SettingsRow[]>`
    SELECT domain_id, provider_id, model, revision, updated_at, updated_by
    FROM llm_gateway_domain_settings
    WHERE domain_id=${domainId}
  `;
  const row = rows[0];
  return row ? toSettingsView(row) : {
    domain_id: domainId,
    provider_id: null,
    model: null,
    revision: 0,
    updated_at: null,
    updated_by: null,
  };
}

/** 列出域别名；只返回 Gateway 维护的模型映射，不读 Core 旧表。 */
export async function listDomainModelAliases(
  db: Db,
  domainId: string,
): Promise<ModelAliasView[]> {
  const rows = await db<ModelAliasRow[]>`
    SELECT domain_id, alias, provider_id, model, description, revision,
      updated_at, updated_by
    FROM llm_gateway_model_aliases
    WHERE domain_id=${domainId}
    ORDER BY alias
  `;
  return rows.map(toAliasView);
}

/** 供出题能力下拉使用的公开能力视图，不暴露 Provider 或真实模型。 */
export async function listDomainModelCapabilities(
  db: Db,
  domainId: string,
): Promise<{ alias: string; description: string }[]> {
  const aliases = await db<{ alias: string; description: string }[]>`
    SELECT alias, description
    FROM llm_gateway_model_aliases
    WHERE domain_id=${domainId}
    ORDER BY alias
  `;
  return [
    { alias: DEFAULT_ALIAS, description: "使用当前工作空间默认模型" },
    ...aliases,
  ];
}

/** 按 revision 原子新增/更新模型别名。 */
export async function upsertDomainModelAlias(
  db: Db,
  domainId: string,
  alias: string,
  input: ModelAliasInput,
  expectedRevision: number,
  actorId: string,
): Promise<ModelAliasView> {
  requireRevision(expectedRevision);
  validateAlias(alias);
  const { providerId, model, description } = validateAliasInput(input);
  await requireEnabledProvider(db, providerId, domainId);
  const updatedAt = now();

  return await db.begin(async (tx) => {
    // 只串行化同一 Gateway 的别名容量/版本检查，避免并发创建绕过 32 条上限。
    await tx`SELECT pg_advisory_xact_lock(184789, 5)`;
    const existing = await tx<ModelAliasRow[]>`
      SELECT domain_id, alias, provider_id, model, description, revision,
        updated_at, updated_by
      FROM llm_gateway_model_aliases
      WHERE domain_id=${domainId} AND alias=${alias}
      FOR UPDATE
    `;
    if (expectedRevision === 0) {
      if (existing.length > 0) {
        throw new ModelAuthorityError(409, "revision_conflict");
      }
      const count = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM llm_gateway_model_aliases
        WHERE domain_id=${domainId}
      `;
      if (Number(count[0]?.count ?? 0) >= MAX_ALIASES) {
        throw new ModelAuthorityError(400, "alias_limit_exceeded");
      }
      const rows = await tx<ModelAliasRow[]>`
        INSERT INTO llm_gateway_model_aliases
          (domain_id, alias, provider_id, model, description, revision,
           updated_at, updated_by)
        VALUES (${domainId}, ${alias}, ${providerId}, ${model}, ${description},
          1, ${updatedAt}, ${actorId})
        RETURNING domain_id, alias, provider_id, model, description, revision,
          updated_at, updated_by
      `;
      return toAliasView(rows[0]!);
    }
    if (existing.length === 0) {
      throw new ModelAuthorityError(404, "alias_not_found");
    }
    if (Number(existing[0]!.revision) !== expectedRevision) {
      throw new ModelAuthorityError(409, "revision_conflict");
    }
    const rows = await tx<ModelAliasRow[]>`
      UPDATE llm_gateway_model_aliases
      SET provider_id=${providerId}, model=${model}, description=${description},
        revision=revision+1, updated_at=${updatedAt}, updated_by=${actorId}
      WHERE domain_id=${domainId} AND alias=${alias}
        AND revision=${expectedRevision}
      RETURNING domain_id, alias, provider_id, model, description, revision,
        updated_at, updated_by
    `;
    if (!rows[0]) throw new ModelAuthorityError(409, "revision_conflict");
    return toAliasView(rows[0]);
  });
}

/** 按 revision 原子删除模型别名。 */
export async function deleteDomainModelAlias(
  db: Db,
  domainId: string,
  alias: string,
  expectedRevision: number,
): Promise<boolean> {
  requireRevision(expectedRevision);
  if (alias === DEFAULT_ALIAS) {
    throw new ModelAuthorityError(400, "reserved_alias");
  }
  return await db.begin(async (tx) => {
    const rows = await tx<{ alias: string }[]>`
      DELETE FROM llm_gateway_model_aliases
      WHERE domain_id=${domainId} AND alias=${alias}
        AND revision=${expectedRevision}
      RETURNING alias
    `;
    if (rows.length > 0) return true;
    const existing = await tx<{ alias: string }[]>`
      SELECT alias FROM llm_gateway_model_aliases
      WHERE domain_id=${domainId} AND alias=${alias}
    `;
    if (existing.length > 0) {
      throw new ModelAuthorityError(409, "revision_conflict");
    }
    return false;
  });
}

/** 按 revision 原子更新域默认模型。null/null 表示明确关闭默认模型。 */
export async function updateDomainModelSettings(
  db: Db,
  domainId: string,
  input: { provider_id: string | null; model: string | null },
  expectedRevision: number,
  actorId: string,
): Promise<DomainModelSettingsView> {
  requireRevision(expectedRevision);
  const { providerId, model } = validateSettingsInput(input);
  if (providerId !== null) {
    await requireEnabledProvider(db, providerId, domainId);
  }
  const updatedAt = now();

  return await db.begin(async (tx) => {
    const existing = await tx<SettingsRow[]>`
      SELECT domain_id, provider_id, model, revision, updated_at, updated_by
      FROM llm_gateway_domain_settings
      WHERE domain_id=${domainId}
      FOR UPDATE
    `;
    if (expectedRevision === 0) {
      if (existing.length > 0) {
        throw new ModelAuthorityError(409, "revision_conflict");
      }
      const rows = await tx<SettingsRow[]>`
        INSERT INTO llm_gateway_domain_settings
          (domain_id, provider_id, model, revision, updated_at, updated_by)
        VALUES (${domainId}, ${providerId}, ${model}, 1, ${updatedAt}, ${actorId})
        RETURNING domain_id, provider_id, model, revision, updated_at, updated_by
      `;
      return toSettingsView(rows[0]!);
    }
    if (existing.length === 0) {
      throw new ModelAuthorityError(409, "revision_conflict");
    }
    if (Number(existing[0]!.revision) !== expectedRevision) {
      throw new ModelAuthorityError(409, "revision_conflict");
    }
    const rows = await tx<SettingsRow[]>`
      UPDATE llm_gateway_domain_settings
      SET provider_id=${providerId}, model=${model}, revision=revision+1,
        updated_at=${updatedAt}, updated_by=${actorId}
      WHERE domain_id=${domainId} AND revision=${expectedRevision}
      RETURNING domain_id, provider_id, model, revision, updated_at, updated_by
    `;
    if (!rows[0]) throw new ModelAuthorityError(409, "revision_conflict");
    return toSettingsView(rows[0]);
  });
}

/** 在 Gateway 内解析一次评测所需的别名集合，并强制同一 Provider。 */
export async function resolveDomainModelSelection(
  db: Db,
  domainId: string,
  aliases: string[],
): Promise<ResolvedModelSelection> {
  if (
    aliases.length === 0 || aliases.length > 8 ||
    aliases.some((alias) =>
      typeof alias !== "string" ||
      !ALIAS_PATTERN.test(alias) && alias !== DEFAULT_ALIAS
    ) ||
    new Set(aliases).size !== aliases.length
  ) {
    throw new ModelAuthorityError(400, "invalid_aliases");
  }
  const settings = await readDomainModelSettings(db, domainId);
  const rows = await db<ModelAliasRow[]>`
    SELECT domain_id, alias, provider_id, model, description, revision,
      updated_at, updated_by
    FROM llm_gateway_model_aliases
    WHERE domain_id=${domainId} AND alias = ANY(${aliases})
  `;
  const byAlias = new Map(rows.map((row) => [row.alias, row]));
  const models: { alias: string; model: string }[] = [];
  const providers = new Set<string>();
  for (const alias of aliases) {
    const row = alias === DEFAULT_ALIAS
      ? settings.provider_id && settings.model
        ? { provider_id: settings.provider_id, model: settings.model }
        : null
      : byAlias.get(alias);
    if (!row) throw new ModelAuthorityError(400, "domain_llm_not_configured");
    providers.add(row.provider_id);
    models.push({ alias, model: row.model });
  }
  if (providers.size !== 1) {
    throw new ModelAuthorityError(400, "mixed_provider");
  }
  await requireEnabledProvider(db, [...providers][0]!, domainId);
  return { provider_id: [...providers][0]!, models };
}
