/**
 * 知识图谱表（P0：内容包、领域、知识点、前置边；P1：题目挂载与 AI 打标记录）。
 *
 * 实例级数据，无 `domain_id`：一个实例任一时刻只启用一个内容包（见
 * openspec/changes/add-knowledge-graph/design.md 第 3 节）。节点发布后
 * 不得删除，只能标记 `deprecated` 并可指定 `replaced_by`。
 *
 * 表 owner：platform（旧模块归属下的共享基础设施；功能代码在
 * `src/features/knowledge/`）。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { problems, problemVersions } from "./catalog.ts";
import { users } from "./identity.ts";

/** 内容包（如 `official`）；`extends` 记录扩展关系 `official@<version>`。 */
export const knowledgePacks = pgTable("knowledge_packs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  license: text("license").notNull(),
  extends: text("extends"),
  /** 实例当前生效的包：全表至多一行 true。 */
  active: boolean("active").notNull().default(false),
  imported_at: text("imported_at").notNull(),
});

/**
 * 领域（内容包内的一级分组，对应 `areas/<area>.yaml`）。
 *
 * 扩展包与被扩展包的领域共用同一张表，`pack_id` 记录首次定义它的包。
 */
export const knowledgeAreas = pgTable(
  "knowledge_areas",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id").notNull().references(() => knowledgePacks.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (table) => ({
    packIndex: index("knowledge_areas_pack_idx").on(table.pack_id),
  }),
);

/** 知识点。`status` 三态之一见 CHECK；废弃节点保留挂载，不删除。 */
export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: text("id").primaryKey(),
    area_id: text("area_id").notNull().references(() => knowledgeAreas.id, {
      onDelete: "cascade",
    }),
    pack_id: text("pack_id").notNull().references(() => knowledgePacks.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    /** 对应考纲键（`pack.yaml` 的 `syllabi` 键），字符串数组。 */
    syllabus: jsonb("syllabus").notNull().$type<string[]>().default(sql`'[]'`),
    /** 讲解文档相对路径（预留，可空）。 */
    doc_path: text("doc_path"),
    status: text("status").notNull().default("active"),
    replaced_by: text("replaced_by"),
    sort: integer("sort").notNull().default(0),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "knowledge_nodes_status_check",
      sql`${table.status} IN ('active', 'deprecated')`,
    ),
    areaIndex: index("knowledge_nodes_area_idx").on(table.area_id),
  }),
);

/** 前置边：`to_id` 依赖 `from_id`（from 是 to 的直接前置）。 */
export const knowledgeEdges = pgTable(
  "knowledge_edges",
  {
    from_id: text("from_id").notNull().references(() => knowledgeNodes.id, {
      onDelete: "cascade",
    }),
    to_id: text("to_id").notNull().references(() => knowledgeNodes.id, {
      onDelete: "cascade",
    }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.from_id, table.to_id] }),
  }),
);

/**
 * 题目—知识点挂载（P1）。
 *
 * 每题至多一条非 rejected 的 `primary`（部分唯一索引保证），`secondary` 由
 * 服务层限制至多 3 条。人工挂载（`source='human'`）整体替换同一题的 AI 挂载，
 * AI 不覆盖人工。`confidence` 为 0–100 整数，仅 AI 挂载有值。
 * `version_id` 记录打标依据的题目版本，题目或版本删除时随挂载一并清理。
 */
export const problemKnowledge = pgTable(
  "problem_knowledge",
  {
    problem_id: text("problem_id").notNull().references(() => problems.id, {
      onDelete: "cascade",
    }),
    node_id: text("node_id").notNull().references(() => knowledgeNodes.id, {
      onDelete: "cascade",
    }),
    role: text("role").notNull(),
    source: text("source").notNull(),
    /** 0–100；人工挂载为空。 */
    confidence: integer("confidence"),
    version_id: text("version_id").references(() => problemVersions.id, {
      onDelete: "cascade",
    }),
    review_status: text("review_status").notNull(),
    /** 最近一次修改该挂载的用户；AI 写入与系统回填为空。 */
    updated_by: text("updated_by").references(() => users.id),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.problem_id, table.node_id] }),
    roleCheck: check(
      "problem_knowledge_role_check",
      sql`${table.role} IN ('primary', 'secondary')`,
    ),
    sourceCheck: check(
      "problem_knowledge_source_check",
      sql`${table.source} IN ('ai', 'human')`,
    ),
    reviewStatusCheck: check(
      "problem_knowledge_review_status_check",
      sql`${table.review_status} IN ('auto', 'pending', 'confirmed', 'rejected')`,
    ),
    confidenceCheck: check(
      "problem_knowledge_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 100)`,
    ),
    /** 每题至多一个有效主知识点；rejected 不占位。 */
    primaryUnique: uniqueIndex("problem_knowledge_primary_uidx")
      .on(table.problem_id)
      .where(
        sql`${table.role} = 'primary' AND ${table.review_status} <> 'rejected'`,
      ),
    nodeIndex: index("problem_knowledge_node_idx").on(table.node_id),
    reviewStatusIndex: index("problem_knowledge_review_status_idx").on(
      table.review_status,
    ),
  }),
);

/**
 * AI 打标运行记录（P1，只建表）。
 *
 * 由 `knowledge.tag` 任务写入（任务 C 负责）：`content_hash` 相同即跳过，
 * 预算类错误记 `budget_paused`。`raw_output` 保留模型原始输出便于复现。
 */
export const knowledgeTagRuns = pgTable(
  "knowledge_tag_runs",
  {
    id: text("id").primaryKey(),
    problem_id: text("problem_id").notNull().references(() => problems.id, {
      onDelete: "cascade",
    }),
    version_id: text("version_id").references(() => problemVersions.id, {
      onDelete: "set null",
    }),
    content_hash: text("content_hash").notNull(),
    model: text("model").notNull(),
    prompt_version: text("prompt_version").notNull(),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
    raw_output: jsonb("raw_output"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "knowledge_tag_runs_status_check",
      sql`${table.status} IN ('succeeded', 'failed', 'skipped', 'budget_paused')`,
    ),
    problemCreatedIndex: index("knowledge_tag_runs_problem_created_idx").on(
      table.problem_id,
      table.created_at,
    ),
  }),
);
