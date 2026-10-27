import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  accountNotifications,
  domains,
  educationNotificationEmails,
  users,
} from "../../../shared/db/schema.ts";
import { isEmailSuppressed } from "../../platform/contracts/cross-module/system_services_email-delivery_service.ts";
import { sendNotificationEmail } from "../../platform/contracts/cross-module/system_services_email.ts";
import { getEducationNotification } from "./notifications.ts";

/** 邮件领取租约存库，多副本与服务重启读取相同待发送事实。 */
export async function claimEducationEmails(limit = 20) {
  const now = new Date().toISOString();
  return await getDb().transaction(async (tx) => {
    const rows = await tx.select().from(educationNotificationEmails).where(and(
      eq(educationNotificationEmails.state, "pending"),
      lte(educationNotificationEmails.available_at, now),
      or(
        isNull(educationNotificationEmails.leased_until),
        lte(educationNotificationEmails.leased_until, now),
      ),
    )).orderBy(
      educationNotificationEmails.available_at,
      educationNotificationEmails.notification_id,
    )
      .limit(limit).for("update", { skipLocked: true });
    if (!rows.length) return [];
    return await tx.update(educationNotificationEmails).set({
      attempts: sql`${educationNotificationEmails.attempts} + 1`,
      lease_token: crypto.randomUUID(),
      leased_until: new Date(Date.now() + 60000).toISOString(),
    }).where(
      inArray(
        educationNotificationEmails.notification_id,
        rows.map((row) => row.notification_id),
      ),
    ).returning();
  });
}

type ClaimedEmail = typeof educationNotificationEmails.$inferSelect;

/** 定位链接不携带题面、评分或私人正文，详情读取仍执行实时授权。 */
export function educationEmailContent(slug: string, assignmentId: string) {
  const appUrl = Deno.env.get("APP_URL")?.trim();
  const url = appUrl
    ? new URL(
      `/d/${encodeURIComponent(slug)}/assignments/${
        encodeURIComponent(assignmentId)
      }`,
      appUrl,
    ).href
    : null;
  const escaped = url?.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    subject: "Neuro OJ 教学通知",
    html: "<p>您有一条新的教学通知。请登录所属工作空间查看。</p>" +
      (escaped ? `<p><a href="${escaped}">查看教学任务</a></p>` : ""),
  };
}

/** 投递前重新授权及解析当前邮箱；同一租约不能重复执行已完成任务。 */
export async function processEducationEmail(
  event: ClaimedEmail,
  send = sendNotificationEmail,
) {
  const db = getDb(), now = new Date().toISOString();
  const [row] = await db.select({
    notice: accountNotifications,
    slug: domains.slug,
    user: users,
  }).from(educationNotificationEmails)
    .innerJoin(
      accountNotifications,
      eq(
        accountNotifications.id,
        educationNotificationEmails.notification_id,
      ),
    )
    .innerJoin(domains, eq(domains.id, accountNotifications.domain_id))
    .innerJoin(users, eq(users.id, accountNotifications.recipient_id)).where(
      and(
        eq(educationNotificationEmails.notification_id, event.notification_id),
        eq(educationNotificationEmails.lease_token, event.lease_token!),
        eq(educationNotificationEmails.state, "pending"),
        sql`${educationNotificationEmails.leased_until} > ${now}`,
      ),
    );
  if (!row || !row.notice.assignment_id) return false;
  let state: "sent" | "skipped" = "skipped", reason: string | null = null;
  try {
    await getEducationNotification(
      row.slug,
      row.notice.recipient_id,
      row.notice.id,
    );
  } catch (error) {
    if (
      error instanceof AppError && [401, 403, 404].includes(error.statusCode)
    ) reason = "revoked";
    else throw error;
  }
  if (!reason && (!row.user.email || !row.user.email_verified)) {
    reason = "no_verified_address";
  }
  if (!reason && await isEmailSuppressed(row.user.email)) reason = "suppressed";
  if (!reason) {
    const message = educationEmailContent(row.slug, row.notice.assignment_id);
    const sent = await send(row.user.email, message.subject, message.html);
    state = sent ? "sent" : "skipped";
    reason = sent ? null : "disabled";
  }
  const applied = await db.update(educationNotificationEmails).set({
    state,
    last_error: reason,
    completed_at: new Date().toISOString(),
    lease_token: null,
    leased_until: null,
  }).where(and(
    eq(educationNotificationEmails.notification_id, event.notification_id),
    eq(educationNotificationEmails.lease_token, event.lease_token!),
    eq(educationNotificationEmails.state, "pending"),
  )).returning({ id: educationNotificationEmails.notification_id });
  return applied.length > 0;
}

/** 临时发送失败只保存错误类型及退避时间，下一次投递重新检查权限。 */
export async function processEducationEmailBatch(
  limit = 20,
  send = sendNotificationEmail,
) {
  const results: Array<{ id: string; succeeded: boolean }> = [];
  for (const event of await claimEducationEmails(limit)) {
    try {
      results.push({
        id: event.notification_id,
        succeeded: await processEducationEmail(event, send),
      });
    } catch (error) {
      await getDb().update(educationNotificationEmails).set({
        lease_token: null,
        leased_until: null,
        available_at: new Date(
          Date.now() + Math.min(60000, 1000 * 2 ** Math.min(event.attempts, 6)),
        ).toISOString(),
        last_error: error instanceof Error ? error.name : "Error",
      }).where(and(
        eq(educationNotificationEmails.notification_id, event.notification_id),
        eq(educationNotificationEmails.lease_token, event.lease_token!),
      ));
      results.push({ id: event.notification_id, succeeded: false });
    }
  }
  return results;
}
