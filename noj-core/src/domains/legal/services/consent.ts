/**
 * 用户同意记录服务（PIPL 合规）。
 *
 * 保留历史多行：查询"当前已同意版本" = 该用户该文档的 MAX(version)。
 * 这样可证明"何时同意过哪一版"。
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { getDb } from "./../../../shared/db/connection.ts";
import { userConsents } from "./../../../shared/db/schema.ts";
import type { LegalKind, UserConsentSnapshot } from "../types.ts";
import { LEGAL_KINDS } from "../types.ts";
import {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
} from "./documents.ts";

const logger = getLogger(["noj", "legal", "consent"]);

/**
 * 取用户在某类文档上"已同意的最新版本"。
 *
 * @param userId 用户 id
 * @param kind 文档类型
 * @returns 最新同意快照；从未同意返回 null
 */
export async function getUserConsent(
  userId: string,
  kind: LegalKind,
): Promise<UserConsentSnapshot | null> {
  const db = getDb();
  const [row] = await db
    .select({
      version: userConsents.version,
      agreed_at: userConsents.agreed_at,
    })
    .from(userConsents)
    .where(
      and(
        eq(userConsents.user_id, userId),
        eq(userConsents.document_kind, kind),
      ),
    )
    .orderBy(desc(userConsents.version))
    .limit(1);
  return row ?? null;
}

/**
 * 记录一次同意。幂等：同一 (user, kind, version) 已存在时静默跳过。
 *
 * @param userId 用户 id
 * @param kind 文档类型
 * @param version 同意的版本号
 * @param hash 该版本内容哈希
 * @param ip 来源 IP（可为 null）
 * @param ua User-Agent（可为 null）
 */
export async function recordConsent(
  userId: string,
  kind: LegalKind,
  version: number,
  hash: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  const db = getDb();
  await db
    .insert(userConsents)
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      document_kind: kind,
      version,
      content_hash: hash,
      agreed_at: new Date().toISOString(),
      ip,
      user_agent: ua,
    })
    .onConflictDoNothing();
}

/**
 * 注册时在同一事务内写入 privacy + terms 的当前版本同意。
 *
 * 供 `registerUser` 的事务调用：传入事务句柄，保证与用户插入原子。
 *
 * @param tx Drizzle 事务句柄（或 db）
 * @param userId 新用户 id
 * @param ip 来源 IP
 * @param ua User-Agent
 */
export async function recordConsentsForRegistration(
  // deno-lint-ignore no-explicit-any
  tx: any,
  userId: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const unpublished: LegalKind[] = [];
  for (const kind of LEGAL_KINDS) {
    const doc = await getCurrentDocument(kind, tx);
    if (!doc) {
      // 尚未发布该文档时无法记录（部署者应先发布）。2026-09-25 评审：这里必须
      // 留痕——否则"允许注册但无政策可同意"的新部署会静默产出一批零同意记录，
      // 运维无从发现漏发布（首版发布后用户会被 needs_consent 弹窗补同意）。
      unpublished.push(kind);
      continue;
    }
    await tx
      .insert(userConsents)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        document_kind: kind,
        version: doc.version,
        content_hash: doc.content_hash,
        agreed_at: now,
        ip,
        user_agent: ua,
      })
      .onConflictDoNothing();
  }
  if (unpublished.length > 0) {
    logger.warn(
      "注册时未找到已发布的法律文档，本次未写入同意记录（部署者应尽快发布政策）",
      { user_id: userId, kinds: unpublished.join(",") },
    );
  }
}

/**
 * 查询用户对全部文档的已同意版本映射（供 `/auth/me` 组装）。
 *
 * @param userId 用户 id
 * @returns kind → 已同意版本号（未同意则不含该 key）
 */
export async function getConsentedVersions(
  userId: string,
): Promise<Partial<Record<LegalKind, number>>> {
  const db = getDb();
  const rows = await db
    .select({
      kind: userConsents.document_kind,
      version: userConsents.version,
    })
    .from(userConsents)
    .where(
      and(
        eq(userConsents.user_id, userId),
        inArray(userConsents.document_kind, [...LEGAL_KINDS]),
      ),
    );
  const out: Partial<Record<LegalKind, number>> = {};
  for (const row of rows) {
    out[row.kind as LegalKind] = Math.max(
      out[row.kind as LegalKind] ?? 0,
      row.version,
    );
  }
  return out;
}

/**
 * 组装某用户对全部法律文档的同意状态（供 `/auth/me` 返回）。
 *
 * 判定口径：**只对重大版本（`is_material`）要求重新同意**。
 * `needs_consent = agreed_version < required_version`，其中
 * `required_version` 是最近一个重大版本号；非重大编辑不触发。
 *
 * @param userId 用户 id
 * @returns kind → 同意状态
 */
export async function getLegalStatus(
  userId: string,
): Promise<
  Record<LegalKind, {
    required_version: number;
    agreed_version: number;
    needs_consent: boolean;
    is_material: boolean;
    /** 需同意的重大版本的变更摘要（供弹窗展示）；无需同意时为 null */
    change_summary: string | null;
  }>
> {
  const agreed = await getConsentedVersions(userId);
  const out = {} as Record<LegalKind, {
    required_version: number;
    agreed_version: number;
    needs_consent: boolean;
    is_material: boolean;
    change_summary: string | null;
  }>;
  for (const kind of LEGAL_KINDS) {
    const required = await getRequiredConsentVersion(kind);
    const agreedVersion = agreed[kind] ?? 0;
    const needsConsent = agreedVersion < required;
    // 仅在需要重新同意时取摘要，避免无谓查询。
    const info = needsConsent ? await getRequiredConsentInfo(kind) : null;
    out[kind] = {
      required_version: required,
      agreed_version: agreedVersion,
      needs_consent: needsConsent,
      is_material: required > 0,
      change_summary: info?.change_summary ?? null,
    };
  }
  return out;
}
