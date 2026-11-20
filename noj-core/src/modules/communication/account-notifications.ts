import { and, count, desc, eq, isNull, type SQL } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import {
  accountNotifications,
  domains,
  users,
} from "../../shared/db/schema.ts";
import { NotFoundError } from "../../shared/base/errors.ts";

/** 业务模块通过通知所有者写入，同一事务中的事件唯一键保证重试幂等。 */
export async function createAccountNotificationTx(
  tx: DbTx,
  input: typeof accountNotifications.$inferInsert,
) {
  const [row] = await tx.insert(accountNotifications).values(input)
    .onConflictDoNothing().returning({ id: accountNotifications.id });
  return row;
}

function projection() {
  return {
    notification: accountNotifications,
    actor: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
    domain: { id: domains.id, slug: domains.slug, name: domains.name },
  };
}

/** 列表、总数和未读数使用同一个已授权谓词，分页前过滤失效资源。 */
export async function listAccountNotifications(
  visible: SQL,
  page: number,
  perPage = 30,
  db: DbRoot | DbTx = getDb(),
) {
  const [data, [total], [unread]] = await Promise.all([
    db.select(projection()).from(accountNotifications)
      .leftJoin(users, eq(users.id, accountNotifications.actor_id))
      .leftJoin(domains, eq(domains.id, accountNotifications.domain_id))
      .where(visible).orderBy(
        desc(accountNotifications.created_at),
        desc(accountNotifications.id),
      )
      .limit(perPage).offset((page - 1) * perPage),
    db.select({ count: count() }).from(accountNotifications).where(visible),
    db.select({ count: count() }).from(accountNotifications).where(
      and(visible, isNull(accountNotifications.read_at)),
    ),
  ]);
  return {
    data,
    total: total.count,
    unread_count: unread.count,
    page,
    per_page: perPage,
  };
}

/** 点击及实时重放再次使用当前授权，失效通知统一返回 404。 */
export async function getAccountNotification(
  visible: SQL,
  id: string,
  db: DbRoot | DbTx = getDb(),
) {
  const [row] = await db.select(projection()).from(accountNotifications)
    .leftJoin(users, eq(users.id, accountNotifications.actor_id))
    .leftJoin(domains, eq(domains.id, accountNotifications.domain_id))
    .where(and(visible, eq(accountNotifications.id, id)));
  if (!row) throw new NotFoundError("通知不存在或不可访问");
  return row;
}

/** 只标记当前可见通知；单条操作和批量操作共享同一授权条件。 */
export async function readAccountNotifications(
  visible: SQL,
  id?: string,
  db: DbRoot | DbTx = getDb(),
) {
  if (id) await getAccountNotification(visible, id, db);
  await db.update(accountNotifications).set({
    read_at: new Date().toISOString(),
  })
    .where(
      and(
        visible,
        isNull(accountNotifications.read_at),
        id ? eq(accountNotifications.id, id) : undefined,
      ),
    );
}
