/**
 * LLM Provider CRUD 服务。
 */
import type { Db } from "./db.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { assertResolvesPublic, type ResolveFn } from "./upstream-guard.ts";
import { logger } from "./logger.ts";

export interface ProviderInput {
  name: string;
  base_url: string;
  api_key: string;
  cost_per_1k_tokens?: number;
  enabled?: boolean;
  /** 每分钟请求数上限（0 = 不限） */
  rpm_limit?: number;
  /** 每分钟 token 数上限（0 = 不限） */
  tpm_limit?: number;
}

export interface ProviderRow {
  id: string;
  revision: number;
  domain_id: string;
  name: string;
  base_url: string;
  cost_per_1k_tokens: number;
  encrypted_api_key: string;
  enabled: boolean;
  /** 每分钟请求数上限（0 = 不限；迁移前的旧行可能缺失） */
  rpm_limit?: number;
  /** 每分钟 token 数上限（0 = 不限；迁移前的旧行可能缺失） */
  tpm_limit?: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderView {
  id: string;
  revision: number;
  domain_id: string;
  name: string;
  base_url: string;
  cost_per_1k_tokens: number;
  /** 脱敏后的 Key，如 `sk-****abcd` */
  api_key_masked: string;
  enabled: boolean;
  /** 每分钟请求数上限（0 = 不限） */
  rpm_limit: number;
  /** 每分钟 token 数上限（0 = 不限） */
  tpm_limit: number;
  created_at: string;
  updated_at: string;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/** 脱敏 API Key：保留前 3 后 4，中间掩码；过短时全部掩码。 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "****";
  }
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

function toView(row: ProviderRow, apiKey: string): ProviderView {
  return {
    id: row.id,
    revision: row.revision,
    domain_id: row.domain_id,
    name: row.name,
    base_url: row.base_url,
    cost_per_1k_tokens: row.cost_per_1k_tokens,
    api_key_masked: maskApiKey(apiKey),
    enabled: row.enabled,
    rpm_limit: row.rpm_limit ?? 0,
    tpm_limit: row.tpm_limit ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 成本单价上界（防止 u64 溢出与荒谬单价）。下界为 0，拒绝负值。 */
const MAX_COST_PER_1K_TOKENS = 1_000_000;

/** 速率上限的上界（PostgreSQL integer 范围内，远超任何上游实际限额）。 */
const MAX_RATE_LIMIT = 1_000_000_000;

/**
 * 校验并规范化 RPM / TPM 上限：缺省为 0（不限），只接受非负整数。
 *
 * @throws {Error} `provider_invalid`：负数、小数、非数字或超过上界
 */
export function normalizeRateLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_RATE_LIMIT) {
    throw new Error("provider_invalid");
  }
  return n;
}

/** 解密失败的掩码：与「Key 过短」的 `****` 区分，便于运维定位密钥轮换/损坏。 */
const DECRYPT_FAILED_MASK = "****(decrypt_failed)";

/**
 * 解密 Provider Key；失败时记 warn（只带 provider id，绝不输出密文/明文）
 * 并返回 null，由调用方决定降级为可区分掩码，不阻断列表/更新。
 */
async function tryDecryptSecret(
  encrypted: string,
  storeKey: string,
  providerId: string,
): Promise<string | null> {
  try {
    return await decryptSecret(encrypted, storeKey);
  } catch {
    logger.warn(
      "Provider Key 解密失败，请检查 NOJ_LLM_STORE_KEY 轮换或密文损坏: {provider_id}",
      {
        provider_id: providerId,
      },
    );
    return null;
  }
}

/** 列出全部 Provider；解密失败时返回不可用的掩码，不阻断列表。 */
export async function listProviders(
  db: Db,
  storeKey: string,
  domainId = "00000000-0000-4000-8000-000000000001",
): Promise<ProviderView[]> {
  const rows = await db<
    ProviderRow[]
  >`SELECT * FROM llm_providers WHERE domain_id = ${domainId} ORDER BY created_at DESC`;
  const views: ProviderView[] = [];
  for (const row of rows) {
    // 密钥轮换/损坏时至少不阻断列表；掩码显示为解密失败
    const apiKey = await tryDecryptSecret(
      row.encrypted_api_key,
      storeKey,
      row.id,
    );
    views.push(
      apiKey === null
        ? { ...toView(row, ""), api_key_masked: DECRYPT_FAILED_MASK }
        : toView(row, apiKey),
    );
  }
  return views;
}

/** 按 ID 查询 Provider 行（含加密 Key，仅内部使用，不得直接对外返回）。 */
export async function getProviderById(
  db: Db,
  id: string,
  domainId = "00000000-0000-4000-8000-000000000001",
): Promise<ProviderRow | null> {
  const rows = await db<
    ProviderRow[]
  >`SELECT * FROM llm_providers WHERE id = ${id} AND domain_id = ${domainId}`;
  return rows[0] ?? null;
}

/** 查询 Provider 并解密其真实 API Key；仅限 gateway 代理/转发流程使用。 */
export async function getProviderSecret(
  db: Db,
  id: string,
  storeKey: string,
  domainId = "00000000-0000-4000-8000-000000000001",
): Promise<{ provider: ProviderRow; apiKey: string }> {
  const provider = await getProviderById(db, id, domainId);
  if (!provider) {
    throw new Error("provider_not_found");
  }
  const apiKey = await decryptSecret(provider.encrypted_api_key, storeKey);
  return { provider, apiKey };
}

/** 新增 Provider：加密 API Key 后落库，返回脱敏视图。 */
export async function createProvider(
  db: Db,
  input: ProviderInput,
  storeKey: string,
  domainId = "00000000-0000-4000-8000-000000000001",
): Promise<ProviderView> {
  const rawCost = input.cost_per_1k_tokens ?? 0;
  const cost = Number(rawCost);
  if (!Number.isFinite(cost) || cost < 0 || cost > MAX_COST_PER_1K_TOKENS) {
    throw new Error("provider_invalid");
  }

  const rpmLimit = normalizeRateLimit(input.rpm_limit);
  const tpmLimit = normalizeRateLimit(input.tpm_limit);

  const id = uuid();
  const createdAt = now();
  const encrypted = await encryptSecret(input.api_key, storeKey);
  await db`
    INSERT INTO llm_providers (id, domain_id, name, base_url, cost_per_1k_tokens, encrypted_api_key, enabled, rpm_limit, tpm_limit, created_at, updated_at)
    VALUES (${id}, ${domainId}, ${input.name}, ${input.base_url}, ${cost}, ${encrypted}, ${
    input.enabled ?? true
  }, ${rpmLimit}, ${tpmLimit}, ${createdAt}, ${createdAt})
  `;
  const row = await getProviderById(db, id, domainId);
  if (!row) throw new Error("provider_not_found");
  return toView(row, input.api_key);
}

/** 更新 Provider 的指定字段；若更新了 Key 则重新加密，未更新则保留原 Key。 */
export async function updateProvider(
  db: Db,
  id: string,
  input: Partial<
    Pick<
      ProviderInput,
      | "name"
      | "base_url"
      | "api_key"
      | "cost_per_1k_tokens"
      | "enabled"
      | "rpm_limit"
      | "tpm_limit"
    >
  >,
  storeKey: string,
  domainId = "00000000-0000-4000-8000-000000000001",
  expectedRevision: number,
): Promise<ProviderView> {
  const existing = await getProviderById(db, id, domainId);
  if (!existing) {
    throw new Error("provider_not_found");
  }

  const updatedAt = now();
  const sets: string[] = [];
  const params: Array<string | number | boolean> = [];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.base_url !== undefined) {
    params.push(input.base_url);
    sets.push(`base_url = $${params.length}`);
  }
  if (input.cost_per_1k_tokens !== undefined) {
    // 负值会让 INCRBY 减少共享配额计数器；荒谬大值会污染配额核算。
    // 无论来源为何都夹取到合法区间（防 u64 溢出与污染配额）。
    const cost = Number(input.cost_per_1k_tokens);
    if (!Number.isFinite(cost) || cost < 0 || cost > MAX_COST_PER_1K_TOKENS) {
      throw new Error("provider_invalid");
    }
    params.push(cost);
    sets.push(`cost_per_1k_tokens = $${params.length}`);
  }
  if (input.enabled !== undefined) {
    params.push(input.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (input.rpm_limit !== undefined) {
    params.push(normalizeRateLimit(input.rpm_limit));
    sets.push(`rpm_limit = $${params.length}`);
  }
  if (input.tpm_limit !== undefined) {
    params.push(normalizeRateLimit(input.tpm_limit));
    sets.push(`tpm_limit = $${params.length}`);
  }
  if (input.api_key !== undefined) {
    const encrypted = await encryptSecret(input.api_key, storeKey);
    params.push(encrypted);
    sets.push(`encrypted_api_key = $${params.length}`);
  }

  params.push(updatedAt, id, domainId, expectedRevision);
  const offset = sets.length + 1;
  const setSql = sets.length > 0
    ? `${sets.join(", ")}, updated_at = $${offset}`
    : `updated_at = $1`;
  const rows = await db.unsafe<ProviderRow[]>(
    `UPDATE llm_providers SET ${setSql}, revision = revision + 1 WHERE id = $${
      offset + 1
    } AND domain_id = $${offset + 2} AND revision = $${offset + 3} RETURNING *`,
    params,
  );
  const row = rows[0];
  if (!row) throw new Error("revision_conflict");
  // 未改 Key 时回显原 Key 的掩码；解密失败降级为可区分掩码，不阻断更新。
  const apiKey = input.api_key ??
    await tryDecryptSecret(row.encrypted_api_key, storeKey, row.id);
  return apiKey === null
    ? { ...toView(row, ""), api_key_masked: DECRYPT_FAILED_MASK }
    : toView(row, apiKey);
}

/** 停用 Provider；历史尝试的配置依据保留。 */
export async function deleteProvider(
  db: Db,
  id: string,
  domainId = "00000000-0000-4000-8000-000000000001",
  expectedRevision: number,
): Promise<boolean> {
  const row = await getProviderById(db, id, domainId);
  if (!row) {
    return false;
  }
  const updated =
    await db`UPDATE llm_providers SET enabled = false, updated_at = ${now()}, revision = revision + 1 WHERE id = ${id} AND domain_id = ${domainId} AND revision = ${expectedRevision} RETURNING id`;
  if (!updated.length) throw new Error("revision_conflict");
  return true;
}

/**
 * 使用固定的最小请求测试 Provider 连通性，不返回上游响应。
 *
 * 访问上游前同样执行出站校验（G-03）：否则状态码差异（鉴权失败/限流/其他）
 * 可被用作内网端口探测的预言机。
 */
export async function testProviderConnection(
  db: Db,
  id: string,
  storeKey: string,
  model: string,
  allowedHosts: Set<string> = new Set(),
  resolve?: ResolveFn,
  domainId = "00000000-0000-4000-8000-000000000001",
): Promise<void> {
  if (!model.trim()) {
    throw new Error("model_required");
  }
  const row = await getProviderById(db, id, domainId);
  if (!row) {
    throw new Error("provider_not_found");
  }
  const baseUrl = row.base_url;
  await assertResolvesPublic(baseUrl, allowedHosts, resolve);
  const { apiKey } = await getProviderSecret(db, id, storeKey, domainId);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("provider_unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("provider_auth_failed");
  }
  if (response.status === 429) throw new Error("provider_rate_limited");
  if (!response.ok) throw new Error("provider_error");
}
