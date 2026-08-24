/**
 * LLM Provider CRUD 服务。
 */
import type { Db } from "./db.ts";
import { encryptSecret, decryptSecret } from "./crypto.ts";

export interface ProviderInput {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  enabled?: boolean;
  created_by?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
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
  /** 脱敏后的 Key，如 `sk-****abcd` */
  api_key_masked: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "****";
  }
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export async function listProviders(db: Db): Promise<ProviderView[]> {
  const rows = await db<ProviderRow[]>`SELECT * FROM llm_providers ORDER BY created_at DESC`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    api_key_masked: maskApiKey(row.encrypted_api_key),
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function getProviderById(
  db: Db,
  id: string,
): Promise<ProviderRow | null> {
  const rows = await db<ProviderRow[]>`SELECT * FROM llm_providers WHERE id = ${id}`;
  return rows[0] ?? null;
}

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

export async function createProvider(
  db: Db,
  input: ProviderInput,
  storeKey: string,
): Promise<ProviderView> {
  const id = uuid();
  const createdAt = now();
  const encrypted = await encryptSecret(input.api_key, storeKey);
  await db`
    INSERT INTO llm_providers (id, name, base_url, model, encrypted_api_key, enabled, created_by, created_at, updated_at)
    VALUES (${id}, ${input.name}, ${input.base_url}, ${input.model}, ${encrypted}, ${input.enabled ?? true}, ${input.created_by ?? "0"}, ${createdAt}, ${createdAt})
  `;
  return {
    id,
    name: input.name,
    base_url: input.base_url,
    model: input.model,
    api_key_masked: maskApiKey(input.api_key),
    enabled: input.enabled ?? true,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function updateProvider(
  db: Db,
  id: string,
  input: Partial<Pick<ProviderInput, "name" | "base_url" | "model" | "api_key" | "enabled">>,
  storeKey: string,
): Promise<ProviderView> {
  const existing = await getProviderById(db, id);
  if (!existing) {
    throw new Error("provider_not_found");
  }
  const updatedAt = now();
  if (input.name !== undefined) {
    await db`UPDATE llm_providers SET name = ${input.name}, updated_at = ${updatedAt} WHERE id = ${id}`;
  }
  if (input.base_url !== undefined) {
    await db`UPDATE llm_providers SET base_url = ${input.base_url}, updated_at = ${updatedAt} WHERE id = ${id}`;
  }
  if (input.model !== undefined) {
    await db`UPDATE llm_providers SET model = ${input.model}, updated_at = ${updatedAt} WHERE id = ${id}`;
  }
  if (input.enabled !== undefined) {
    await db`UPDATE llm_providers SET enabled = ${input.enabled}, updated_at = ${updatedAt} WHERE id = ${id}`;
  }
  if (input.api_key !== undefined) {
    const encrypted = await encryptSecret(input.api_key, storeKey);
    await db`UPDATE llm_providers SET encrypted_api_key = ${encrypted}, updated_at = ${updatedAt} WHERE id = ${id}`;
  }
  if (
    input.name === undefined && input.base_url === undefined &&
    input.model === undefined && input.enabled === undefined &&
    input.api_key === undefined
  ) {
    await db`UPDATE llm_providers SET updated_at = ${updatedAt} WHERE id = ${id}`;
  }

  const row = await getProviderById(db, id);
  if (!row) {
    throw new Error("provider_not_found");
  }
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    api_key_masked: maskApiKey(row.encrypted_api_key),
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
