import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  emailDeliveryEvents,
  emailSuppressions,
} from "../../../../shared/db/schema.ts";
import { metrics } from "../../../../shared/base/metrics.ts";
import type {
  EmailDeliveryEvent,
  NormalizedEmailDeliveryEvent,
} from "./types.ts";

function truncate(value: string | undefined, max: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : null;
}

/** 邮箱哈希用于抑制查询，避免数据库保存完整收件地址。 */
export async function hashEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@", 2);
  const visible = local.slice(0, 1) || "*";
  return `${visible}***@${domain}`;
}

export async function normalizeEmailDeliveryEvent(
  event: EmailDeliveryEvent,
): Promise<NormalizedEmailDeliveryEvent> {
  return {
    provider: event.provider,
    providerEventId: event.providerEventId,
    type: event.type,
    occurredAt: event.occurredAt,
    reasonCode: truncate(event.reasonCode, 128) ?? undefined,
    reason: truncate(event.reason, 512) ?? undefined,
    recipientHash: await hashEmail(event.email),
    recipientMasked: maskEmail(event.email),
  };
}

export async function ingestEmailDeliveryEvent(
  event: NormalizedEmailDeliveryEvent,
): Promise<{ duplicate: boolean; suppressed: boolean }> {
  const db = getDb();
  const receivedAt = new Date().toISOString();
  const inserted = await db.insert(emailDeliveryEvents).values({
    id: crypto.randomUUID(),
    provider: event.provider,
    provider_event_id: event.providerEventId,
    event_type: event.type,
    recipient_hash: event.recipientHash,
    recipient_masked: event.recipientMasked,
    reason_code: event.reasonCode ?? null,
    reason: event.reason ?? null,
    occurred_at: event.occurredAt,
    received_at: receivedAt,
  }).onConflictDoNothing({
    target: [
      emailDeliveryEvents.provider,
      emailDeliveryEvents.provider_event_id,
    ],
  }).returning({ id: emailDeliveryEvents.id });

  if (inserted.length === 0) {
    metrics.inc("noj_email_delivery_events_duplicate_total", {
      provider: event.provider,
    });
    return {
      duplicate: true,
      suppressed: await isEmailHashSuppressed(event.recipientHash),
    };
  }

  metrics.inc("noj_email_delivery_events_total", {
    provider: event.provider,
    event_type: event.type,
  });
  if (event.type === "temporary_failure") {
    metrics.inc("noj_email_temporary_failures_total", {
      provider: event.provider,
    });
  }

  if (event.type !== "permanent_bounce" && event.type !== "complaint") {
    return {
      duplicate: false,
      suppressed: await isEmailHashSuppressed(event.recipientHash),
    };
  }

  const reason = `${event.type}${
    event.reasonCode ? `:${event.reasonCode}` : ""
  }`;
  const existing = await db.select({ id: emailSuppressions.id }).from(
    emailSuppressions,
  )
    .where(
      and(
        eq(emailSuppressions.recipient_hash, event.recipientHash),
        isNull(emailSuppressions.cleared_at),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    await db.update(emailSuppressions).set({
      reason,
      provider: event.provider,
      source_event_id: event.providerEventId,
      suppressed_at: receivedAt,
      recipient_masked: event.recipientMasked,
    }).where(eq(emailSuppressions.id, existing[0].id));
  } else {
    await db.insert(emailSuppressions).values({
      id: crypto.randomUUID(),
      recipient_hash: event.recipientHash,
      recipient_masked: event.recipientMasked,
      reason,
      provider: event.provider,
      source_event_id: event.providerEventId,
      suppressed_at: receivedAt,
      cleared_at: null,
      cleared_by: null,
    });
  }
  metrics.inc("noj_email_suppressions_total", {
    provider: event.provider,
    reason: event.type,
  });
  return { duplicate: false, suppressed: true };
}

async function isEmailHashSuppressed(recipientHash: string): Promise<boolean> {
  const row = await getDb().select({ id: emailSuppressions.id }).from(
    emailSuppressions,
  )
    .where(
      and(
        eq(emailSuppressions.recipient_hash, recipientHash),
        isNull(emailSuppressions.cleared_at),
      ),
    )
    .limit(1);
  return row.length > 0;
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  return await isEmailHashSuppressed(await hashEmail(email));
}

export async function listEmailSuppressions(limit = 100) {
  return await getDb().select({
    id: emailSuppressions.id,
    recipient_masked: emailSuppressions.recipient_masked,
    reason: emailSuppressions.reason,
    provider: emailSuppressions.provider,
    source_event_id: emailSuppressions.source_event_id,
    suppressed_at: emailSuppressions.suppressed_at,
    cleared_at: emailSuppressions.cleared_at,
    cleared_by: emailSuppressions.cleared_by,
  }).from(emailSuppressions).orderBy(desc(emailSuppressions.suppressed_at))
    .limit(
      Math.max(1, Math.min(limit, 200)),
    );
}

export async function clearEmailSuppression(id: string, clearedBy: string) {
  const rows = await getDb().update(emailSuppressions).set({
    cleared_at: new Date().toISOString(),
    cleared_by: clearedBy,
  }).where(
    and(eq(emailSuppressions.id, id), isNull(emailSuppressions.cleared_at)),
  )
    .returning({ id: emailSuppressions.id });
  return rows.length > 0;
}
