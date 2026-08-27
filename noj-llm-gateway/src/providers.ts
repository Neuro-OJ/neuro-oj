/**
 * LLM Provider CRUD 服务。
 */
import type { Db } from "./db.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";

export interface ProviderInput {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  cost_per_1k_tokens?: number;
  enabled?: boolean;
  created_by?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  cost_per_1k_tokens: number;
  encrypted_api_key: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderView {
  id: string;
  name: string;
  base_url: string;
  model: string;
  cost_per_1k_tokens: number;
  /** 脱敏后的 Key，如 `sk-****abcd` */
  api_key_masked: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** BYOK Provider 仅允许运维配置的 HTTPS 公共主机。 */
export function validateByokBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("provider_target_rejected");
  }
  const allowed = new Set(
    (Deno.env.get("NOJ_LLM_BYOK_ALLOWED_HOSTS") ?? "api.openai.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443") ||
    !allowed.has(hostname) ||
    isPrivateHostname(hostname)
  ) {
    throw new Error("provider_target_rejected");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname === "::1"
  ) return true;
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  return octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
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
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    cost_per_1k_tokens: row.cost_per_1k_tokens,
    api_key_masked: maskApiKey(apiKey),
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateByokFields(input: {
  name?: string;
  model?: string;
  api_key?: string;
}): void {
  if (
    input.name !== undefined &&
    (input.name.trim().length === 0 || input.name.length > 200)
  ) {
    throw new Error("provider_invalid");
  }
  if (
    input.model !== undefined &&
    (input.model.trim().length === 0 || input.model.length > 200)
  ) {
    throw new Error("provider_invalid");
  }
  if (
    input.api_key !== undefined &&
    (input.api_key.trim().length === 0 || input.api_key.length > 8192)
  ) {
    throw new Error("provider_invalid");
  }
}

/** 列出全部 Provider；解密失败时返回不可用的掩码，不阻断列表。 */
export async function listProviders(
  db: Db,
  storeKey: string,
  createdBy?: string,
): Promise<ProviderView[]> {
  const rows = createdBy === undefined
    ? await db<
      ProviderRow[]
    >`SELECT * FROM llm_providers ORDER BY created_at DESC`
    : await db<
      ProviderRow[]
    >`SELECT * FROM llm_providers WHERE created_by = ${createdBy} ORDER BY created_at DESC`;
  const views: ProviderView[] = [];
  for (const row of rows) {
    let apiKey = "";
    try {
      apiKey = await decryptSecret(row.encrypted_api_key, storeKey);
    } catch {
      // 密钥轮换/损坏时至少不阻断列表；掩码显示不可用
    }
    views.push(toView(row, apiKey));
  }
  return views;
}

/** 按 ID 查询 Provider 行（含加密 Key，仅内部使用，不得直接对外返回）。 */
export async function getProviderById(
  db: Db,
  id: string,
): Promise<ProviderRow | null> {
  const rows = await db<
    ProviderRow[]
  >`SELECT * FROM llm_providers WHERE id = ${id}`;
  return rows[0] ?? null;
}

/** 查询 Provider 并解密其真实 API Key；仅限 gateway 代理/转发流程使用。 */
export async function getProviderSecret(
  db: Db,
  id: string,
  storeKey: string,
): Promise<{ provider: ProviderRow; apiKey: string }> {
  const provider = await getProviderById(db, id);
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
): Promise<ProviderView> {
  if (input.created_by && input.created_by !== "0") {
    validateByokFields(input);
    input = { ...input, base_url: validateByokBaseUrl(input.base_url) };
  }
  const id = uuid();
  const createdAt = now();
  const encrypted = await encryptSecret(input.api_key, storeKey);
  await db`
    INSERT INTO llm_providers (id, name, base_url, model, cost_per_1k_tokens, encrypted_api_key, enabled, created_by, created_at, updated_at)
    VALUES (${id}, ${input.name}, ${input.base_url}, ${input.model}, ${
    input.cost_per_1k_tokens ?? 0
  }, ${encrypted}, ${input.enabled ?? true}, ${
    input.created_by ?? "0"
  }, ${createdAt}, ${createdAt})
  `;
  const row = await getProviderById(db, id);
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
      | "model"
      | "api_key"
      | "cost_per_1k_tokens"
      | "enabled"
    >
  >,
  storeKey: string,
): Promise<ProviderView> {
  const existing = await getProviderById(db, id);
  if (!existing) {
    throw new Error("provider_not_found");
  }
  if (existing.created_by !== "0") {
    validateByokFields(input);
  }
  const updatedAt = now();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.base_url !== undefined) {
    params.push(
      existing.created_by !== "0"
        ? validateByokBaseUrl(input.base_url)
        : input.base_url,
    );
    sets.push(`base_url = $${params.length}`);
  }
  if (input.model !== undefined) {
    params.push(input.model);
    sets.push(`model = $${params.length}`);
  }
  if (input.cost_per_1k_tokens !== undefined) {
    params.push(input.cost_per_1k_tokens);
    sets.push(`cost_per_1k_tokens = $${params.length}`);
  }
  if (input.enabled !== undefined) {
    params.push(input.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (input.api_key !== undefined) {
    const encrypted = await encryptSecret(input.api_key, storeKey);
    params.push(encrypted);
    sets.push(`encrypted_api_key = $${params.length}`);
  }

  params.push(updatedAt, id);
  const offset = sets.length + 1;
  const setSql = sets.length > 0
    ? `${sets.join(", ")}, updated_at = $${offset}`
    : `updated_at = $1`;
  await db.unsafe(
    `UPDATE llm_providers SET ${setSql} WHERE id = $${offset + 1}`,
    ...(params as never[]),
  );

  const row = await getProviderById(db, id);
  if (!row) {
    throw new Error("provider_not_found");
  }
  const apiKey = input.api_key ??
    (await decryptSecret(row.encrypted_api_key, storeKey).catch(() => ""));
  return toView(row, apiKey);
}

/** 删除 Provider；若指定 owner 则同时校验归属。 */
export async function deleteProvider(
  db: Db,
  id: string,
  createdBy?: string,
): Promise<boolean> {
  const row = await getProviderById(db, id);
  if (!row || (createdBy !== undefined && row.created_by !== createdBy)) {
    return false;
  }
  await db`DELETE FROM llm_providers WHERE id = ${id}`;
  return true;
}

/** 使用固定的最小请求测试 Provider 连通性，不返回上游响应。 */
export async function testProviderConnection(
  db: Db,
  id: string,
  storeKey: string,
  createdBy?: string,
): Promise<void> {
  const row = await getProviderById(db, id);
  if (!row || (createdBy !== undefined && row.created_by !== createdBy)) {
    throw new Error("provider_not_found");
  }
  const baseUrl = row.created_by !== "0"
    ? validateByokBaseUrl(row.base_url)
    : row.base_url;
  const { apiKey } = await getProviderSecret(db, id, storeKey);
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
        model: row.model,
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
