/**
 * 用户自带模型（BYOK）服务。
 *
 * 与平台/域 Provider（`providers.ts`）在归属与存储上完全分离：
 * - 表 `llm_user_providers`，主键即 `user_id`，每个用户至多一条；
 * - 写入字段白名单化（只接受 base_url / model / api_key / enabled），
 *   不会整包转发请求体（防 mass assignment）；
 * - 上游地址必须命中 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 精确白名单、https，
 *   调用前再做公网 DNS 校验；白名单为空时 BYOK 整体关闭。
 */
import type { Db } from "./db.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { maskApiKey } from "./providers.ts";
import {
  fetchPinned,
  type PublicResolution,
  type ResolveFn,
  resolvePublicUpstream,
  UPSTREAM_BLOCKED,
} from "./upstream-guard.ts";

/** eval_token 中 BYOK Provider 的 ID 前缀：`byok:<user_id>`。 */
export const BYOK_PROVIDER_PREFIX = "byok:";

/** BYOK 未启用（白名单为空）时的稳定错误码。 */
export const BYOK_DISABLED = "byok_disabled";

const MAX_FIELD_LENGTH = 512;
const MAX_API_KEY_LENGTH = 4096;

/** 用户 Provider 的 token 内 ID。 */
export function byokProviderId(userId: string): string {
  return `${BYOK_PROVIDER_PREFIX}${userId}`;
}

/** 是否为 BYOK token Provider ID。 */
export function isByokProviderId(providerId: string): boolean {
  return providerId.startsWith(BYOK_PROVIDER_PREFIX);
}

export interface UserProviderRow {
  user_id: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface UserProviderView {
  provider_id: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** 写入白名单：除这几个字段外的任何输入都会被忽略。 */
export interface UserProviderInput {
  base_url?: unknown;
  model?: unknown;
  api_key?: unknown;
  enabled?: unknown;
}

function toView(row: UserProviderRow, apiKey: string | null): UserProviderView {
  return {
    provider_id: byokProviderId(row.user_id),
    base_url: row.base_url,
    model: row.model,
    api_key_masked: apiKey === null
      ? "****(decrypt_failed)"
      : maskApiKey(apiKey),
    enabled: row.enabled,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 校验 BYOK 上游地址：白名单非空、主机精确命中、https、无 userinfo。
 *
 * @throws {Error} `byok_disabled` / `provider_base_url_blocked`
 */
export function assertByokBaseUrl(
  baseUrl: string,
  allowedHosts: Set<string>,
): void {
  if (allowedHosts.size === 0) throw new Error(BYOK_DISABLED);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(UPSTREAM_BLOCKED);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(UPSTREAM_BLOCKED);
  }
  const host = url.hostname.toLowerCase();
  const hostWithPort = url.port ? `${host}:${url.port}` : host;
  if (!allowedHosts.has(host) && !allowedHosts.has(hostWithPort)) {
    throw new Error(UPSTREAM_BLOCKED);
  }
}

/**
 * 调用前出站校验：白名单 + 公网 DNS（白名单主机也不允许解析到内网）。
 *
 * 与平台 Provider 不同，这里**不**传入 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`，
 * 用户永远不能借网关访问内网地址。
 */
export async function resolveByokUpstream(
  baseUrl: string,
  allowedHosts: Set<string>,
  resolve?: ResolveFn,
): Promise<PublicResolution> {
  assertByokBaseUrl(baseUrl, allowedHosts);
  return await resolvePublicUpstream(baseUrl, new Set(), resolve);
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("provider_invalid");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error("provider_invalid");
  return trimmed;
}

export async function getUserProviderRow(
  db: Db,
  userId: string,
): Promise<UserProviderRow | null> {
  const rows = await db<
    UserProviderRow[]
  >`SELECT * FROM llm_user_providers WHERE user_id = ${userId}`;
  return rows[0] ?? null;
}

/** 读取用户 Provider 视图（Key 脱敏）；不存在返回 null。 */
export async function getUserProvider(
  db: Db,
  userId: string,
  storeKey: string,
): Promise<UserProviderView | null> {
  const row = await getUserProviderRow(db, userId);
  if (!row) return null;
  const apiKey = await decryptSecret(row.encrypted_api_key, storeKey).catch(
    () => null,
  );
  return toView(row, apiKey);
}

/** 读取用户 Provider 与明文 Key；仅限代理转发使用。 */
export async function getUserProviderSecret(
  db: Db,
  userId: string,
  storeKey: string,
): Promise<{ provider: UserProviderRow; apiKey: string }> {
  const provider = await getUserProviderRow(db, userId);
  if (!provider) throw new Error("provider_not_found");
  const apiKey = await decryptSecret(provider.encrypted_api_key, storeKey);
  return { provider, apiKey };
}

/**
 * 创建或更新用户 Provider（乐观锁）。
 *
 * - `expectedRevision = 0` 表示创建，此时 base_url / model / api_key 必填；
 * - 更新时缺省字段保持原值，`api_key` 缺省即保留原 Key。
 *
 * @throws {Error} `provider_invalid` / `byok_disabled` /
 *   `provider_base_url_blocked` / `revision_conflict`
 */
export async function saveUserProvider(
  db: Db,
  userId: string,
  input: UserProviderInput,
  storeKey: string,
  allowedHosts: Set<string>,
  expectedRevision: number,
): Promise<UserProviderView> {
  const creating = expectedRevision === 0;
  const baseUrl = input.base_url === undefined && !creating
    ? undefined
    : requiredString(input.base_url, MAX_FIELD_LENGTH);
  const model = input.model === undefined && !creating
    ? undefined
    : requiredString(input.model, MAX_FIELD_LENGTH);
  const apiKey = input.api_key === undefined && !creating
    ? undefined
    : requiredString(input.api_key, MAX_API_KEY_LENGTH);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("provider_invalid");
  }
  const enabled = input.enabled as boolean | undefined;
  if (baseUrl !== undefined) assertByokBaseUrl(baseUrl, allowedHosts);
  else if (allowedHosts.size === 0) throw new Error(BYOK_DISABLED);

  const now = new Date().toISOString();
  const encrypted = apiKey === undefined
    ? undefined
    : await encryptSecret(apiKey, storeKey);

  let row: UserProviderRow | undefined;
  if (creating) {
    [row] = await db<UserProviderRow[]>`
      INSERT INTO llm_user_providers
        (user_id, base_url, model, encrypted_api_key, enabled, revision, created_at, updated_at)
      VALUES (${userId}, ${baseUrl!}, ${model!}, ${encrypted!}, ${
      enabled ?? true
    }, 1, ${now}, ${now})
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *`;
  } else {
    [row] = await db<UserProviderRow[]>`
      UPDATE llm_user_providers SET
        base_url = COALESCE(${baseUrl ?? null}, base_url),
        model = COALESCE(${model ?? null}, model),
        encrypted_api_key = COALESCE(${encrypted ?? null}, encrypted_api_key),
        enabled = COALESCE(${enabled ?? null}, enabled),
        revision = revision + 1,
        updated_at = ${now}
      WHERE user_id = ${userId} AND revision = ${expectedRevision}
      RETURNING *`;
  }
  if (!row) throw new Error("revision_conflict");
  const plain = apiKey ??
    await decryptSecret(row.encrypted_api_key, storeKey).catch(() => null);
  return toView(row, plain);
}

/** 删除用户 Provider（含加密 Key）；不存在返回 false。 */
export async function deleteUserProvider(
  db: Db,
  userId: string,
): Promise<boolean> {
  const rows =
    await db`DELETE FROM llm_user_providers WHERE user_id = ${userId} RETURNING user_id`;
  return rows.length > 0;
}

/**
 * 用已保存的 Key 发一次 `max_tokens: 1` 的请求测试连通性，不返回上游响应体。
 *
 * @throws {Error} `provider_not_found` / `byok_disabled` /
 *   `provider_base_url_blocked` / `provider_auth_failed` /
 *   `provider_rate_limited` / `provider_unavailable` / `provider_error`
 */
export async function testUserProvider(
  db: Db,
  userId: string,
  storeKey: string,
  allowedHosts: Set<string>,
  resolve?: ResolveFn,
): Promise<void> {
  const { provider, apiKey } = await getUserProviderSecret(
    db,
    userId,
    storeKey,
  );
  const resolution = await resolveByokUpstream(
    provider.base_url,
    allowedHosts,
    resolve,
  );
  let response: Response;
  try {
    response = await fetchPinned(
      `${provider.base_url.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      },
      resolution,
    );
  } catch {
    throw new Error("provider_unavailable");
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new Error("provider_auth_failed");
  }
  if (response.status === 429) throw new Error("provider_rate_limited");
  if (!response.ok) throw new Error("provider_error");
}
