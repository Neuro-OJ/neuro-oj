import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 法律文档身份表（PIPL 合规）。
 *
 * 每类文档（隐私政策 / 服务条款）一份，`current_version` 指向最新已发布版本。
 * 版本内容不可变、只追加，见 {@link legalDocumentVersions}。
 */
export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: text("id").primaryKey(),
    /** 文档类型：privacy=隐私政策，terms=服务条款 */
    kind: text("kind").notNull(),
    /** 最新已发布版本号；0 表示尚未发布 */
    current_version: integer("current_version").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    kindUnique: unique("legal_documents_kind_unique").on(table.kind),
    kindCheck: check(
      "legal_documents_kind_check",
      sql`${table.kind} IN ('privacy', 'terms')`,
    ),
  }),
);

/**
 * 法律文档版本表（不可变历史）。
 *
 * 改政策 = 追加新版本；已发布版本行不允许修改。
 * - `is_material`：重大变更标记，决定是否要求用户重新同意（只对重大版本判定）。
 * - `tsa_*`：可选 RFC 3161 时间戳（含证书链，供长期验证）。
 */
export const legalDocumentVersions = pgTable(
  "legal_document_versions",
  {
    id: text("id").primaryKey(),
    document_id: text("document_id").notNull().references(
      () => legalDocuments.id,
      { onDelete: "cascade" },
    ),
    /** 版本号，随文档单调递增 */
    version: integer("version").notNull(),
    /** Markdown 正文 */
    content: text("content").notNull(),
    /** 规范化内容的 SHA-256（同意记录据此绑定"同意的是哪一版内容"） */
    content_hash: text("content_hash").notNull(),
    /** 变更摘要（变更弹窗展示，可选） */
    change_summary: text("change_summary"),
    /** 是否重大变更（决定是否触发重新同意） */
    is_material: boolean("is_material").notNull().default(false),
    published_at: text("published_at").notNull(),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 时间戳 Provider 标识（disabled 时为空） */
    tsa_provider: text("tsa_provider"),
    /** RFC 3161 时间戳响应中的 TimeStampToken（base64，含 CMS 签名） */
    tsa_token: text("tsa_token"),
    /** 时间戳证书链（base64，多证书以换行分隔；长期验证必需） */
    tsa_chain: text("tsa_chain"),
    /** 原始 RFC 3161 请求（base64，含 nonce），供事后重放/复核 */
    tsa_query: text("tsa_query"),
    /** 时间戳签发时间（TSTInfo.genTime，ISO 8601；TSA 签名保证） */
    tsa_timestamp: text("tsa_timestamp"),
  },
  (table) => ({
    docVersionUnique: unique("legal_document_versions_doc_version_unique").on(
      table.document_id,
      table.version,
    ),
    /** 查询最近一个重大版本（getRequiredConsentVersion） */
    materialIdx: index("idx_legal_versions_material").on(
      table.document_id,
      table.is_material,
      table.version,
    ),
  }),
);

/**
 * 用户同意记录表（PIPL 履责证据核心）。
 *
 * 保留历史多行：查询"当前已同意版本" = 该用户该文档的 MAX(version)。
 * 这样可证明"何时同意过哪一版"，比只存一行更强。
 */
export const userConsents = pgTable(
  "user_consents",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    /** 文档类型，与 legal_documents.kind 对齐 */
    document_kind: text("document_kind").notNull(),
    /** 同意的版本号 */
    version: integer("version").notNull(),
    /** 同意时该版本的内容哈希 */
    content_hash: text("content_hash").notNull(),
    agreed_at: text("agreed_at").notNull(),
    /** 同意来源 IP（可信代理解析，可能为 null） */
    ip: text("ip"),
    /** 同意时的 User-Agent */
    user_agent: text("user_agent"),
  },
  (table) => ({
    userDocVersionUnique: unique("user_consents_user_doc_version_unique").on(
      table.user_id,
      table.document_kind,
      table.version,
    ),
    // 2026-09-25 评审：合规证据核心表补齐取值约束（同层 legal_documents /
    // data_requests / carousel_slides 都有 CHECK，唯独此表缺失）。
    kindCheck: check(
      "user_consents_kind_check",
      sql`${table.document_kind} IN ('privacy', 'terms')`,
    ),
  }),
);

/**
 * 删除/更正请求表（PIPL 权利保障）。
 *
 * 注销已覆盖"账户删除"；本表覆盖**内容类**（帖子/提交等）的删除更正请求。
 * 轻量状态机：pending → processing → resolved | rejected。
 */
export const dataRequests = pgTable(
  "data_requests",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    /** 请求类型：delete=删除，correct=更正 */
    kind: text("kind").notNull(),
    /** 请求对象类型 */
    target_type: text("target_type").notNull(),
    /** 请求对象 id（可选） */
    target_id: text("target_id"),
    /** 申请人说明 */
    detail: text("detail").notNull(),
    /** 处理状态 */
    status: text("status").notNull().default("pending"),
    /** 处理人用户 id */
    handled_by: text("handled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    handled_at: text("handled_at"),
    /** 处理结果说明 */
    resolution: text("resolution"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    kindCheck: check(
      "data_requests_kind_check",
      sql`${table.kind} IN ('delete', 'correct')`,
    ),
    statusCheck: check(
      "data_requests_status_check",
      sql`${table.status} IN ('pending', 'processing', 'resolved', 'rejected')`,
    ),
    /** 管理端按状态 + 时间列出 */
    statusCreatedIdx: index("idx_data_requests_status_created").on(
      table.status,
      table.created_at,
    ),
    /** 用户查自己的请求 */
    userIdx: index("idx_data_requests_user").on(
      table.user_id,
      table.created_at,
    ),
  }),
);
