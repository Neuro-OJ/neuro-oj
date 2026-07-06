/**
 * IP 黑名单 service（issue #102）。
 *
 * - listIpBans：分页 + 模糊搜索（按 ip_or_cidr）
 * - addIpBan：新增；CIDR 校验（拒绝 0.0.0.0/0）+ 重复检测
 * - removeIpBan：按 id 删除
 * - getBannedRanges：返回所有未过期的 ip_or_cidr 列表（给 banlistMiddleware 用，含 60s LRU 缓存）
 *
 * 审计日志：每次写操作 console.log "[admin] actor=... action=... key=... value=..."
 */

import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { ipBans } from "../db/schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { isBannedIp, isValidIpOrCidr } from "../lib/cidr.ts";
import { getCached, invalidateBanCache } from "../lib/banCache.ts";
import { logAudit } from "./audit-log.ts";

export interface IpBan {
  id: string;
  ip_or_cidr: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface AddIpBanInput {
  ip_or_cidr: string;
  reason?: string;
  expires_at?: string | null;
}

export interface ListIpBansOpts {
  page: number;
  perPage: number;
  keyword?: string;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

/** 分页列表。 */
export async function listIpBans(
  opts: ListIpBansOpts,
): Promise<{ data: IpBan[]; pagination: Pagination }> {
  const db = getDb();
  const offset = (opts.page - 1) * opts.perPage;

  const conditions = [];
  if (opts.keyword) {
    conditions.push(like(ipBans.ip_or_cidr, `%${opts.keyword}%`));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db.select().from(ipBans).where(where)
      .orderBy(ipBans.created_at)
      .limit(opts.perPage).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(ipBans).where(where),
  ]);

  const total = Number(countResult[0]?.count ?? 0);
  return {
    data: rows,
    pagination: {
      page: opts.page,
      per_page: opts.perPage,
      total,
      total_pages: Math.ceil(total / opts.perPage),
    },
  };
}

/** 新增 IP 黑名单。 */
export async function addIpBan(
  input: AddIpBanInput,
  actorId: string,
): Promise<IpBan> {
  const trimmed = input.ip_or_cidr.trim();
  if (!isValidIpOrCidr(trimmed)) {
    throw new ValidationError(
      "IP/CIDR 格式无效，或不能是 0.0.0.0/0（会封禁整个 IPv4 互联网）",
    );
  }

  // 校验 expires_at（如提供）必须是有效 ISO 8601
  if (input.expires_at) {
    const t = Date.parse(input.expires_at);
    if (Number.isNaN(t)) {
      throw new ValidationError("expires_at 必须是有效 ISO 8601 字符串");
    }
  }

  const db = getDb();
  // 重复检测
  const existing = await db.select().from(ipBans)
    .where(eq(ipBans.ip_or_cidr, trimmed))
    .limit(1);
  if (existing.length > 0) {
    throw new ConflictError(`IP/CIDR 已存在：${trimmed}`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(ipBans).values({
    id,
    ip_or_cidr: trimmed,
    reason: input.reason ?? "",
    expires_at: input.expires_at ?? null,
    created_at: now,
    created_by: actorId,
  });

  // 失效 ip_bans 全表缓存
  invalidateBanCache({ ipOrCidr: trimmed });
  logAudit(
    "ip_ban.create",
    {
      action: "ip_ban.create",
      ip_or_cidr: trimmed,
      reason: input.reason ?? "",
      expires_at: input.expires_at ?? null,
    },
    { type: "ip_bans", id },
  );

  return {
    id,
    ip_or_cidr: trimmed,
    reason: input.reason ?? "",
    expires_at: input.expires_at ?? null,
    created_at: now,
    created_by: actorId,
  };
}

/** 删除 IP 黑名单。 */
export async function removeIpBan(
  id: string,
  _actorId: string,
): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(ipBans)
    .where(eq(ipBans.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError(`IP 黑名单条目不存在：${id}`);
  }
  await db.delete(ipBans).where(eq(ipBans.id, id));

  invalidateBanCache({ ipOrCidr: existing[0]!.ip_or_cidr });
  logAudit(
    "ip_ban.delete",
    { action: "ip_ban.delete", ip_or_cidr: existing[0]!.ip_or_cidr },
    { type: "ip_bans", id },
  );
}

/**
 * 获取所有未过期 ip_or_cidr（给中间件用，60s LRU 缓存）。
 * 已过期条目（expires_at < now）被自动过滤，避免过期封禁继续生效。
 */
export async function getBannedRanges(): Promise<string[]> {
  return await getCached("ip_bans:all", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const rows = await db.select({
      ip_or_cidr: ipBans.ip_or_cidr,
    })
      .from(ipBans)
      .where(
        or(
          isNull(ipBans.expires_at),
          sql`${ipBans.expires_at} > ${now}`,
        ),
      );
    return rows.map((r) => r.ip_or_cidr);
  });
}

/**
 * 查询指定 IP 是否被封禁，返回匹配到的条目详情（给 ban-status 端点用）。
 * 使用 60s LRU 缓存（全表缓存，与 getBannedRanges 同 TTL 失效）。
 */
export async function getBannedIpDetail(
  clientIp: string,
): Promise<
  {
    matched_cidr: string;
    reason: string;
    expires_at: string | null;
    created_at: string;
  } | null
> {
  // 使用全表缓存，但 key 独立于 getBannedRanges 避免序列化差异
  const rows = await getCached("ip_bans:detail", async () => {
    const db = getDb();
    return await db.select().from(ipBans);
  });
  const now = new Date().toISOString();
  for (const row of rows) {
    if (
      (!row.expires_at || row.expires_at > now) &&
      isBannedIp(clientIp, [row.ip_or_cidr])
    ) {
      return {
        matched_cidr: row.ip_or_cidr,
        reason: row.reason,
        expires_at: row.expires_at,
        created_at: row.created_at,
      };
    }
  }
  return null;
}

/** 启动期一次全量加载（与 system-settings initSystemSettings 同模式）。 */
let _initialized = false;
export async function initBanlist(): Promise<void> {
  if (_initialized) return;
  await getBannedRanges();
  _initialized = true;
}

/** 测试用：重置内部状态。 */
export function _resetBanlistForTest(): void {
  _initialized = false;
}
