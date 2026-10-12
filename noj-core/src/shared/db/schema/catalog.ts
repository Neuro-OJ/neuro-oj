import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manyToManyPk, publicIdColumn, tsvector } from "./common.ts";
import { ROOT_USER_ID } from "../../base/constants.ts";
import { users } from "./identity.ts";
import { storageObjects } from "./system.ts";
import type {
  ProblemObjectRole,
  ProblemVersionOrigin,
} from "../../versioning/types.ts";

/**
 * 题目版本表（Handbook §2.3）。
 *
 * 一份**完整、已发布**的作答与评测内容；发布后不可修改（DB 触发器守卫）。
 * 版本号在单题内递增（P12 的 V3 ≠ P13 的 V3）；跨表引用一律使用版本 UUID。
 *
 * 定义顺序说明：本表**先于** `problems` 定义。`problem_id → problems.id` 走惰性
 * `.references()` 回调，而 `problems.latest_version_id` 需要复合外键
 * `(problem_id, id)`——`drizzle-orm@0.45` 的 `foreignKey()` 在定义处立即求值列
 * 数组，因此只能让被引用方先定义，两个方向才能都在 schema 中声明。
 */
export const problemVersions = pgTable(
  "problem_versions",
  {
    id: text("id").primaryKey(),
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    /** 单题内递增版本号，≥1。展示与批量选择使用它，跨表引用使用 `id`。 */
    version: integer("version").notNull(),
    /** 内容 schema 版本，当前恒为 1。 */
    schema_version: integer("schema_version").notNull().default(1),
    /** `migration_baseline` 是存量迁移基线，**不是**历史提交的真实提交时版本。 */
    origin: text("origin").$type<ProblemVersionOrigin>().notNull().default(
      "published",
    ),
    /** 完整 `ProblemContentV1`；服务端校验后才可写入。 */
    content: jsonb("content").notNull(),
    /** 新发布版本必填；迁移基线允许为空（存量内容形态未规范化）。 */
    content_sha256: text("content_sha256"),
    change_note: text("change_note").notNull().default(""),
    published_by: text("published_by").references(() => users.id, {
      onDelete: "set null",
    }),
    published_at: text("published_at").notNull(),
  },
  (table) => ({
    problemVersionUnique: unique("problem_versions_problem_version_unique").on(
      table.problem_id,
      table.version,
    ),
    /** 供 `problems` / 提交 / 竞赛固定版本的复合外键引用。 */
    problemIdIdUnique: unique("problem_versions_problem_id_id_unique").on(
      table.problem_id,
      table.id,
    ),
    problemPublishedIdx: index("idx_problem_versions_problem_published").on(
      table.problem_id,
      table.published_at,
    ),
    versionCheck: check(
      "problem_versions_version_check",
      sql`${table.version} >= 1`,
    ),
    schemaVersionCheck: check(
      "problem_versions_schema_version_check",
      sql`${table.schema_version} >= 1`,
    ),
    originCheck: check(
      "problem_versions_origin_check",
      sql`${table.origin} IN ('published', 'migration_baseline')`,
    ),
    contentCheck: check(
      "problem_versions_content_check",
      sql`jsonb_typeof(${table.content}) = 'object'`,
    ),
  }),
);

/**
 * 题目草稿表（Handbook §2.4）。
 * 每题一个共享草稿，权限沿用题目编辑权限；所有修改必须校验预期 revision。
 */
export const problemDrafts = pgTable(
  "problem_drafts",
  {
    problem_id: text("problem_id").primaryKey().references(() => problems.id, {
      onDelete: "cascade",
    }),
    /** 草稿基线版本；必须属于该题（复合外键）。可空表示尚无已发布版本。 */
    base_version_id: text("base_version_id"),
    /** 乐观锁 revision，编辑、上传文件、增删客观题小题均递增同一个值。 */
    revision: integer("revision").notNull().default(1),
    /** 草稿内容，允许暂时不完整。 */
    content: jsonb("content").notNull(),
    updated_by: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    revisionCheck: check(
      "problem_drafts_revision_check",
      sql`${table.revision} >= 1`,
    ),
    contentCheck: check(
      "problem_drafts_content_check",
      sql`jsonb_typeof(${table.content}) = 'object'`,
    ),
    baseVersionFk: foreignKey({
      name: "problem_drafts_base_version_fk",
      columns: [table.problem_id, table.base_version_id],
      foreignColumns: [problemVersions.problem_id, problemVersions.id],
    }),
  }),
);

/**
 * 草稿文件引用表（Handbook §2.5）。
 * 发布时按行复制引用，不复制文件字节；草稿后续替换引用不影响历史版本。
 */
export const problemDraftObjects = pgTable(
  "problem_draft_objects",
  {
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    role: text("role").$type<ProblemObjectRole>().notNull(),
    path: text("path").notNull(),
    storage_url: text("storage_url")
      .notNull()
      .references(() => storageObjects.storage_url),
  },
  (table) => ({
    /** UNIQUE (problem_id, role, path)：一个逻辑路径只能有一个当前引用。 */
    pk: primaryKey({
      name: "problem_draft_objects_pk",
      columns: [table.problem_id, table.role, table.path],
    }),
    roleCheck: check(
      "problem_draft_objects_role_check",
      sql`${table.role} IN ('support_package', 'oi_file')`,
    ),
    storageIdx: index("idx_problem_draft_objects_storage_url").on(
      table.storage_url,
    ),
  }),
);

/**
 * 已发布版本文件引用表（Handbook §2.5）。
 * 不可变：随版本一同固定，删除整题时随版本级联清理。
 */
export const problemVersionObjects = pgTable(
  "problem_version_objects",
  {
    version_id: text("version_id")
      .notNull()
      .references(() => problemVersions.id, { onDelete: "cascade" }),
    role: text("role").$type<ProblemObjectRole>().notNull(),
    path: text("path").notNull(),
    storage_url: text("storage_url")
      .notNull()
      .references(() => storageObjects.storage_url),
  },
  (table) => ({
    /** UNIQUE (version_id, role, path)。 */
    pk: primaryKey({
      name: "problem_version_objects_pk",
      columns: [table.version_id, table.role, table.path],
    }),
    roleCheck: check(
      "problem_version_objects_role_check",
      sql`${table.role} IN ('support_package', 'oi_file')`,
    ),
    storageIdx: index("idx_problem_version_objects_storage_url").on(
      table.storage_url,
    ),
  }),
);

/**
 * 题目表。
 * 每道题定义独立的评测环境（Docker 镜像 + 支持包 + 评测命令）。
 * 不包含 test_cases——测试用例由支持包 zip 内的评测脚本自行管理。
 *
 * 版本化后（2026-10-09）：`title` / `description` / `runtime_config` / `samples` /
 * `template_content` / `llm_config` / `artifact_max_size_mb` 是**最新版投影**，
 * 仅由发布服务更新，草稿保存不触碰；所有作答、评测与历史查看一律读
 * `problem_versions.content`（Handbook §2.2）。
 */
export const problems = pgTable(
  "problems",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** 公开样例独立于题面，旧题目缺省为空数组。 */
    samples: jsonb("samples").default(sql`'[]'::jsonb`),
    /** OI 数据文件索引；NULL 表示尚未从旧评测包转换。 */
    oi_data_files: jsonb("oi_data_files"),
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
    /** 最新已发布版本；空表示尚未发布（普通访问者 404，编辑者走草稿接口）。 */
    latest_version_id: text("latest_version_id"),
    /** 题库有效版本策略：any=历史版本均可产生有效成绩；exact=只采用要求版本。 */
    effective_version_mode: text("effective_version_mode").notNull().default(
      "any",
    ),
    /** `exact` 时的要求版本；`any` 时必须为空。 */
    required_version_id: text("required_version_id"),
    /** 策略乐观锁与投影版本号：每次策略切换递增。 */
    effective_policy_revision: integer("effective_policy_revision").notNull()
      .default(0),
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
    effectiveVersionModeCheck: check(
      "problems_effective_version_mode_check",
      sql`${table.effective_version_mode} IN ('any', 'exact')`,
    ),
    /** `any` ⇔ 无要求版本；`exact` ⇔ 有要求版本。 */
    effectiveVersionPolicyCheck: check(
      "problems_effective_version_policy_check",
      sql`(${table.effective_version_mode} = 'any' AND ${table.required_version_id} IS NULL)
        OR (${table.effective_version_mode} = 'exact' AND ${table.required_version_id} IS NOT NULL)`,
    ),
    effectivePolicyRevisionCheck: check(
      "problems_effective_policy_revision_check",
      sql`${table.effective_policy_revision} >= 0`,
    ),
    // 复合外键 `problems.(id, latest_version_id) → problem_versions.(problem_id, id)`
    // 与 `problems.(id, required_version_id) → problem_versions.(problem_id, id)`
    // **故意不在此声明**：`problem_versions.problem_id → problems.id` 与它们构成
    // 类型层面的互相引用，而 `drizzle-orm@0.45` 的 `foreignKey()` 立即求值列数组，
    // TypeScript 会推出 `any`（TS7022/TS7024）。两条约束由迁移与 PGlite DDL 以
    // `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` 建立，语义完全一致。
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
