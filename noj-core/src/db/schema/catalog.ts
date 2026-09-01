import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tsvector } from "./common.ts";
import { ROOT_USER_ID } from "../../lib/constants.ts";
import { users } from "./identity.ts";

export const problems = pgTable(
  "problems",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull().default("medium"),
    /** 支持包存储 URL（`noj-storage://` 格式） */
    support_package_storage_url: text("support_package_storage_url"),
    /**
     * 双容器 Runtime 配置（U/P 型必填；客观题套卷 is_objective=true 时为 NULL）。
     * 包含 evaluator 和 solution 两个容器的运行时配置。
     */
    runtime_config: jsonb("runtime_config"),
    /** 题号（同一 type 内独立自增） */
    number: integer("number").notNull(),
    /** 题目所有者 ID，默认 root (UID=0) */
    owner_id: text("owner_id").notNull().default(ROOT_USER_ID),
    /** 题目类型：U=用户题库, P=主题库 */
    type: text("type").notNull().default("U"),
    /** 客观题标记：true 表示该题目是客观题套卷（无评测容器，服务端即时判定） */
    is_objective: boolean("is_objective").notNull().default(false),
    /** 提交模式：code=单文件代码提交（默认），artifact=zip 产物提交 */
    submission_mode: text("submission_mode").notNull().default("code"),
    /** artifact 提交大小上限（MB），NULL = 使用 NOJ 硬上限 */
    artifact_max_size_mb: integer("artifact_max_size_mb"),
    /** LLM 网关配置（可空）：{ provider_id, model }，仅受信题目可启用 */
    llm_config: jsonb("llm_config"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护，ORM 不可写入 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    typeNumberUnique: unique("problems_type_number_unique").on(
      table.type,
      table.number,
    ),
    typeCheck: check(
      "problems_type_check",
      sql`${table.type} IN ('U', 'P')`,
    ),
    submissionModeCheck: check(
      "problems_submission_mode_check",
      sql`${table.submission_mode} IN ('code', 'artifact')`,
    ),
    searchVectorIdx: index("idx_problems_search_vector").using(
      "gin",
      table.searchVector,
    ),
    runtimeConfigCheck: check(
      "problems_runtime_config_check",
      sql`${table.runtime_config} IS NULL OR jsonb_typeof(${table.runtime_config}) = 'object'`,
    ),
  }),
);

export const tags = pgTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    kindCheck: check(
      "tags_kind_check",
      sql`${table.kind} IN ('problem', 'algorithm')`,
    ),
  }),
);

export const problemTags = pgTable(
  "problem_tags",
  {
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    tag_id: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.problem_id, table.tag_id] }),
  }),
);

export const trainings = pgTable(
  "trainings",
  {
    id: text("id").primaryKey(),
    public_id: text("public_id").notNull().default(
      sql`'tr-' || substr(md5(random()::text), 1, 8)`,
    ),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    is_pinned: boolean("is_pinned").notNull().default(false),
    created_by: text("created_by").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    publicIdUnique: unique("trainings_public_id_unique").on(table.public_id),
    visibilityCheck: check(
      "trainings_visibility_check",
      sql`${table.visibility} IN ('private', 'unlisted', 'public')`,
    ),
    visibilityPinnedCreatedIdx: index(
      "idx_trainings_visibility_pinned_created",
    ).on(table.visibility, table.is_pinned, table.created_at),
    createdByIdx: index("idx_trainings_created_by").on(table.created_by),
  }),
);

export const trainingProblems = pgTable(
  "training_problems",
  {
    training_id: text("training_id")
      .notNull()
      .references(() => trainings.id, { onDelete: "cascade" }),
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.training_id, table.problem_id] }),
    positionUnique: unique(
      "training_problems_training_position_unique",
    ).on(table.training_id, table.position),
    trainingPositionIdx: index(
      "idx_training_problems_training_position",
    ).on(table.training_id, table.position),
  }),
);
