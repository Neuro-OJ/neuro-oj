/**
 * 知识图谱表（P0：内容包、领域、知识点、前置边）。
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
} from "drizzle-orm/pg-core";

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
