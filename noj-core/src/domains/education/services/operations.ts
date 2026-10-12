import { and, eq } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { educationOperations } from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";

/** 调用方先取得班级锁并重新验证授权，才允许读取幂等结果。 */
export async function educationOperation<T extends Record<string, unknown>>(
  executor: Executor,
  domainId: string,
  actorId: string,
  operation: string,
  key: string,
  input: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  if (typeof key !== "string" || !key.trim() || key.length > 200) {
    throw new BadRequestError(
      "需要有效的 Idempotency-Key",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const hash = Array.from(
    new Uint8Array(digest),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const [previous] = await executor.select().from(educationOperations).where(
    and(
      eq(educationOperations.domain_id, domainId),
      eq(educationOperations.actor_id, actorId),
      eq(educationOperations.operation, operation),
      eq(educationOperations.idempotency_key, key),
    ),
  );
  if (previous) {
    if (previous.request_hash !== hash) {
      throw new ConflictError("幂等键已用于不同请求", "IDEMPOTENCY_CONFLICT");
    }
    return previous.result as T;
  }
  const result = await perform();
  await executor.insert(educationOperations).values({
    id: crypto.randomUUID(),
    domain_id: domainId,
    actor_id: actorId,
    operation,
    idempotency_key: key,
    request_hash: hash,
    result,
    created_at: new Date().toISOString(),
  });
  return result;
}
