import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manyToManyPk, publicIdColumn, tsvector } from "./common.ts";
import { ROOT_USER_ID } from "../../base/constants.ts";
import { users } from "./identity.ts";

/**
 * 题目表。
 * 每道题定义独立的评测环境（Docker 镜像 + 支持包 + 评测命令）。
 * 不包含 test_cases——测试用例由支持包 zip 内的评测脚本自行管理。
 */
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
    /** 评测模式：存量题目默认 dual。 */
    judge_type: text("judge_type").notNull().default("dual"),
    /** 题号（同一 type 内独立自增） */
    number: integer("number").notNull(),
    /** 题目所有者 ID，默认 root (UID=0) */
    owner_id: text("owner_id").notNull().default(ROOT_USER_ID),
    /** 题目类型：U=用户题库, P=主题库 */
    type: text("type").notNull().default("U"),
    /** 客观题标记：true 表示该题目是客观题套卷（无评测容器，服务端即时判定） */
    is_objective: boolean("is_objective").notNull().default(false),
    visibility: text("visibility").notNull().default("public"),
    /** 提交模式：code=单文件代码提交（默认），artifact=zip 产物提交 */
    submission_mode: text("submission_mode").notNull().default("code"),
    /** artifact 提交大小上限（MB），NULL = 使用 NOJ 硬上限 */
    artifact_max_size_mb: integer("artifact_max_size_mb"),
    /**
     * 编辑器初始代码模板（starter code）内容。
     *
     * 导入题目包时从包内 `manifest.template` 声明的文件（缺省 `template.py`）
     * 读取并落库——与题面（`description`）同源同策略：元数据随包上传、
     * 导入时持久化，运行期不再依赖服务器本地源码目录。
     *
     * 取值语义（`resolveProblemTemplate` 据此决定是否回源读支持包）：
     * - 非空字符串：模板内容；
     * - `''`：导入时**已核对**过包内没有模板 → 不再为读模板下载整个支持包；
     * - `NULL`：本列引入前的存量行（来源未知）→ 允许回源探测包内 `template.py`。
     *
     * 客观题套卷与未提供模板的题目为 NULL 或 `''`（套卷恒 NULL）。
     */
    template_content: text("template_content"),
    /**
     * 题目 LLM 配置（可空）：`{ provider_id, model, max_calls?, max_tokens? }`。
     *
     * 2026-09-22 起语义收窄为「题目声明的能力与预算」：Provider/模型由**平台
     * 默认**（`llm_default_provider_id` / `llm_default_model`）决定，
     * `provider_id` / `model` 保留为用户/题包显式指定的覆盖值（可空）。
     */
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
    visibilityCheck: check(
      "problems_visibility_check",
      sql`${table.visibility} IN ('public', 'private')`,
    ),
    pVisibilityCheck: check(
      "problems_p_visibility_check",
      sql`${table.type} <> 'P' OR ${table.visibility} = 'public'`,
    ),
    searchVectorIdx: index("idx_problems_search_vector").using(
      "gin",
      table.searchVector,
    ),
    judgeTypeCheck: check(
      "problems_judge_type_check",
      sql`${table.judge_type} IN ('dual', 'oi')`,
    ),
    runtimeConfigCheck: check(
      "problems_runtime_config_check",
      sql`${table.runtime_config} IS NULL OR jsonb_typeof(${table.runtime_config}) = 'object'`,
    ),
  }),
);

/**
 * 标签表（issue #223：category 系统退役，双类标签取代）。
 * 扁平结构（无树）：name 全局唯一（跨 kind）。
 * kind：problem=题目标签（人人可见）｜algorithm=算法标签（通过题目后可见）。
 */
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

/**
 * 题目-标签关联表。
 * 多对多关系，双级联删除。
 */
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
    ...manyToManyPk([table.problem_id, table.tag_id]),
  }),
);

/**
 * 题单主表（issue #224）。
 * visibility: private=仅创建者 / unlisted=URL 可访问 / public=出现在题单列表页。
 */
export const trainings = pgTable(
  "trainings",
  {
    id: text("id").primaryKey(),
    public_id: publicIdColumn("tr"),
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

/**
 * 题单题目关联表。
 * position 在单个题单内保持唯一；题目删除时级联清理。
 */
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
    ...manyToManyPk([table.training_id, table.problem_id]),
    positionUnique: unique(
      "training_problems_training_position_unique",
    ).on(table.training_id, table.position),
    trainingPositionIdx: index(
      "idx_training_problems_training_position",
    ).on(table.training_id, table.position),
  }),
);
