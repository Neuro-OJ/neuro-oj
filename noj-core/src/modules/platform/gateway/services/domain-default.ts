import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { domainLlmSettings } from "../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { getLlmPlatformDefault } from "./llm.ts";

/** 仅默认域首次继承旧配置；已有域设置（包括明确关闭）永不被启动覆盖。 */
export async function seedDomainLlmDefaults(executor: Executor = getDb()) {
  const legacy = getLlmPlatformDefault();
  if (!legacy) return;
  await executor.insert(domainLlmSettings).values({
    domain_id: DEFAULT_DOMAIN_ID,
    provider_id: legacy.provider_id,
    model: legacy.model,
    revision: 1,
    updated_at: new Date().toISOString(),
  }).onConflictDoNothing();
}

/** 执行时读取使用域选择，不从源题或其他域继承模型。 */
export async function getDomainLlmDefault(
  domainId: string,
  executor: Executor = getDb(),
) {
  const [settings] = await executor.select().from(domainLlmSettings).where(
    eq(domainLlmSettings.domain_id, domainId),
  );
  return settings?.provider_id && settings.model
    ? { provider_id: settings.provider_id, model: settings.model }
    : null;
}
