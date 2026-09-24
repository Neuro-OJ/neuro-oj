/**
 * 法律文档服务层（PIPL 合规）。
 *
 * 提供：
 * - `hashContent()`：规范化内容的 SHA-256，供同意记录绑定"同意的是哪一版内容"。
 * - `getCurrentDocument()`：取当前版本（含正文）。
 * - `getRequiredConsentVersion()`：取最近一个"重大"版本号；**只对重大版本要求重新同意**。
 * - `listVersions()`：版本历史。
 * - `publishVersion()`：发布新版本（不可变追加），可选打时间戳（见 `tsa.ts`）。
 *
 * 约定：版本行只追加、不可修改；改政策 = 发新版本。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  legalDocuments,
  legalDocumentVersions,
} from "./../../../shared/db/schema.ts";
import {
  ConflictError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import type {
  LegalDocumentSnapshot,
  LegalKind,
  LegalVersionSummary,
} from "../types.ts";
import { isLegalKind } from "../types.ts";
import { timestampHash, tsaEnabled } from "./tsa.ts";

/**
 * 规范化文档内容。
 *
 * 规范化：统一换行为 `\n`、去除首尾空白。这样"同一份内容"在不同编辑器/
 * 平台下得到相同哈希，避免因换行符差异制造出"看似不同的版本"。
 *
 * 2026-09-25 评审：`publishVersion` 落库的正文必须与 `content_hash` 使用**同一份**
 * 规范化结果，否则"哈希可独立复核正文"的说法在首尾空白/CRLF 场景下不成立。
 *
 * @param content Markdown 正文
 * @returns 规范化后的正文
 */
export function normalizeContent(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/**
 * 规范化文档内容后计算 SHA-256。
 *
 * @param content Markdown 正文
 * @returns 小写十六进制哈希
 */
export async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeContent(content));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 断言 kind 合法，否则抛 ValidationError（路由层 400）。 */
function assertKind(kind: string): asserts kind is LegalKind {
  if (!isLegalKind(kind)) {
    throw new ValidationError(`未知的法律文档类型：${kind}`);
  }
}

/** 判断数据库错误是否为唯一约束冲突（PG 23505；PGlite 在 `cause.code`）。 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const pgCode = rec.code ??
    ((rec.cause as Record<string, unknown> | undefined)?.code);
  return pgCode === "23505";
}

/**
 * 取某类文档的当前版本（含正文）。
 *
 * @param kind 文档类型
 * @param dbHandle 可选的数据库/事务句柄（事务内调用必须传入 tx，避免单连接死锁）
 * @returns 当前快照；尚未发布任何版本时返回 null
 */
export async function getCurrentDocument(
  kind: LegalKind,
  // deno-lint-ignore no-explicit-any
  dbHandle: any = getDb(),
): Promise<LegalDocumentSnapshot | null> {
  assertKind(kind);
  const db = dbHandle;
  const [doc] = await db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.kind, kind))
    .limit(1);
  if (!doc || doc.current_version <= 0) return null;

  const [row] = await db
    .select()
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.document_id, doc.id),
        eq(legalDocumentVersions.version, doc.current_version),
      ),
    )
    .limit(1);
  if (!row) return null;

  return {
    kind,
    version: row.version,
    content: row.content,
    content_hash: row.content_hash,
    is_material: row.is_material,
  };
}

/**
 * 取"需要用户同意的版本号" = 最近一个 `is_material=true` 的版本。
 *
 * 非重大编辑（错字/排版）不参与判定，因此不会打扰用户重新同意。
 *
 * @returns 版本号；无重大版本时返回 0
 */
export async function getRequiredConsentVersion(
  kind: LegalKind,
): Promise<number> {
  assertKind(kind);
  const db = getDb();
  const [doc] = await db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.kind, kind))
    .limit(1);
  if (!doc) return 0;

  const [row] = await db
    .select({ version: legalDocumentVersions.version })
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.document_id, doc.id),
        eq(legalDocumentVersions.is_material, true),
      ),
    )
    .orderBy(desc(legalDocumentVersions.version))
    .limit(1);
  return row?.version ?? 0;
}

/**
 * 取"需同意的重大版本"详情（版本号 + 变更摘要），供变更弹窗展示。
 *
 * 与 `getRequiredConsentVersion` 同一口径（最近一个 `is_material` 版本），
 * 额外返回 `change_summary`。
 *
 * @returns 详情；无重大版本时返回 null
 */
export async function getRequiredConsentInfo(
  kind: LegalKind,
): Promise<{ version: number; change_summary: string | null } | null> {
  assertKind(kind);
  const db = getDb();
  const [doc] = await db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.kind, kind))
    .limit(1);
  if (!doc) return null;

  const [row] = await db
    .select({
      version: legalDocumentVersions.version,
      change_summary: legalDocumentVersions.change_summary,
    })
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.document_id, doc.id),
        eq(legalDocumentVersions.is_material, true),
      ),
    )
    .orderBy(desc(legalDocumentVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * 列出某类文档的版本历史（最新在前，不含正文）。
 *
 * @param kind 文档类型
 */
export async function listVersions(
  kind: LegalKind,
): Promise<LegalVersionSummary[]> {
  assertKind(kind);
  const db = getDb();
  const [doc] = await db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.kind, kind))
    .limit(1);
  if (!doc) return [];

  const rows = await db
    .select({
      version: legalDocumentVersions.version,
      published_at: legalDocumentVersions.published_at,
      is_material: legalDocumentVersions.is_material,
      change_summary: legalDocumentVersions.change_summary,
    })
    .from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.document_id, doc.id))
    .orderBy(desc(legalDocumentVersions.version));
  return rows;
}

/**
 * 发布新版本（不可变追加）。
 *
 * 事务内：文档行不存在则创建 → `current_version + 1` → 插入版本行（含内容哈希）
 * → 更新 `current_version`。若启用 TSA 且为重大变更，**同步**打时间戳；
 * 打戳失败不阻塞发布（`tsa_*` 保持 null）。
 *
 * @param kind 文档类型
 * @param content Markdown 正文
 * @param changeSummary 变更摘要（可选）
 * @param isMaterial 是否重大变更
 * @param userId 发布者用户 id
 * @returns 新版本号
 */
export async function publishVersion(
  kind: LegalKind,
  content: string,
  changeSummary: string | null,
  isMaterial: boolean,
  userId: string,
): Promise<number> {
  assertKind(kind);
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ValidationError("文档内容不能为空");
  }
  const db = getDb();
  const now = new Date().toISOString();
  // 正文与哈希同源：落库的是规范化结果，保证 content_hash 可独立复核 content。
  const normalized = normalizeContent(content);
  const contentHash = await hashContent(normalized);

  const newVersion = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.kind, kind))
      .limit(1);

    let docId: string;
    let version: number;
    if (!doc) {
      docId = crypto.randomUUID();
      version = 1;
      try {
        await tx.insert(legalDocuments).values({
          id: docId,
          kind,
          current_version: version,
          created_at: now,
          updated_at: now,
        });
      } catch (err) {
        // 同一 kind 的 `legal_documents_kind_unique`：两个管理员同时首发布时，
        // 后到者在此撞唯一键（2026-09-25 评审）→ 409 而非 500。
        if (isUniqueViolation(err)) {
          throw new ConflictError("该文档已被其他管理员创建，请刷新后重试");
        }
        throw err;
      }
    } else {
      docId = doc.id;
      version = doc.current_version + 1;
      // 乐观锁（2026-09-25 评审）：并发发布会算出同一个 version，进而撞
      // legal_document_versions 的唯一键并以未翻译异常 500 返回。这里按
      // 读到的 current_version 做条件更新，未命中即判为并发冲突 → 409。
      const updated = await tx
        .update(legalDocuments)
        .set({ current_version: version, updated_at: now })
        .where(
          and(
            eq(legalDocuments.id, docId),
            eq(legalDocuments.current_version, doc.current_version),
          ),
        )
        .returning({ id: legalDocuments.id });
      if (updated.length === 0) {
        throw new ConflictError(
          "该文档已被其他管理员发布新版本，请刷新后重试",
        );
      }
    }

    await tx.insert(legalDocumentVersions).values({
      id: crypto.randomUUID(),
      document_id: docId,
      version,
      content: normalized,
      content_hash: contentHash,
      change_summary: changeSummary,
      is_material: isMaterial,
      published_at: now,
      created_by: userId,
    });

    return version;
  });

  // 打时间戳：失败不阻塞发布（政策发布是低频人工操作，可容忍降级）。
  if (isMaterial && tsaEnabled()) {
    const result = await timestampHash(contentHash);
    if (result) {
      const [doc] = await db
        .select({ id: legalDocuments.id })
        .from(legalDocuments)
        .where(eq(legalDocuments.kind, kind))
        .limit(1);
      if (doc) {
        await db
          .update(legalDocumentVersions)
          .set({
            tsa_provider: result.provider,
            tsa_token: result.token,
            tsa_chain: result.chain,
            tsa_query: result.query,
            tsa_timestamp: result.timestamp,
          })
          .where(
            and(
              eq(legalDocumentVersions.document_id, doc.id),
              eq(legalDocumentVersions.version, newVersion),
            ),
          );
      }
    }
  }

  return newVersion;
}

/**
 * 读取某版本保存的时间戳记录（供管理端验证）。
 *
 * @param kind 文档类型
 * @param version 版本号
 * @returns 时间戳字段；无记录或该版本不存在时返回 null
 */
export async function getVersionTsa(
  kind: LegalKind,
  version: number,
): Promise<
  {
    content_hash: string;
    provider: string | null;
    token: string | null;
    chain: string | null;
    query: string | null;
    timestamp: string | null;
  } | null
> {
  assertKind(kind);
  const db = getDb();
  const [doc] = await db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.kind, kind))
    .limit(1);
  if (!doc) return null;

  const [row] = await db
    .select({
      content_hash: legalDocumentVersions.content_hash,
      tsa_provider: legalDocumentVersions.tsa_provider,
      tsa_token: legalDocumentVersions.tsa_token,
      tsa_chain: legalDocumentVersions.tsa_chain,
      tsa_query: legalDocumentVersions.tsa_query,
      tsa_timestamp: legalDocumentVersions.tsa_timestamp,
    })
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.document_id, doc.id),
        eq(legalDocumentVersions.version, version),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    content_hash: row.content_hash,
    provider: row.tsa_provider,
    token: row.tsa_token,
    chain: row.tsa_chain,
    query: row.tsa_query,
    timestamp: row.tsa_timestamp,
  };
}
