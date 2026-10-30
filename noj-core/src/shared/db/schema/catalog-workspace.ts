import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { problems, problemVersions, trainings } from "./catalog.ts";
import { users } from "./identity.ts";
import { domains } from "./workspace.ts";
import type { EffectiveVersionMode } from "../../versioning/types.ts";

/** 使用域对源题的唯一题库配置；撤销授权不删除提交所依赖的绑定。 */
export const domainProblemBindings = pgTable("domain_problem_bindings", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  problem_id: text("problem_id").notNull().references(() => problems.id),
  kind: text("kind").$type<"owned" | "shared">().notNull(),
  visibility: text("visibility").$type<"public" | "members">().notNull()
    .default("members"),
  revision: integer("revision").notNull().default(0),
  disabled_at: text("disabled_at"),
  created_by: text("created_by").notNull().references(() => users.id),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  identityUnique: unique("domain_problem_bindings_identity_unique").on(
    t.domain_id,
    t.problem_id,
  ),
  domainIdUnique: unique("domain_problem_bindings_domain_id_unique").on(
    t.domain_id,
    t.id,
  ),
  idProblemUnique: unique("domain_problem_bindings_id_problem_unique").on(
    t.id,
    t.problem_id,
  ),
  kindCheck: check(
    "domain_problem_bindings_kind_check",
    sql`${t.kind} IN ('owned', 'shared')`,
  ),
  visibilityCheck: check(
    "domain_problem_bindings_visibility_check",
    sql`${t.visibility} IN ('public', 'members')`,
  ),
  revisionCheck: check(
    "domain_problem_bindings_revision_check",
    sql`${t.revision} >= 0`,
  ),
  sourceIdx: index("idx_domain_problem_bindings_source").on(
    t.problem_id,
    t.domain_id,
  ),
}));

/** 绑定策略或状态变化的解释依据，保留每个 revision 的完整快照。 */
export const problemBindingHistory = pgTable("problem_binding_history", {
  id: text("id").primaryKey(),
  binding_id: text("binding_id").notNull(),
  problem_id: text("problem_id").notNull(),
  revision: integer("revision").notNull(),
  effective_version_mode: text("effective_version_mode").$type<
    EffectiveVersionMode
  >().notNull(),
  required_version_id: text("required_version_id"),
  answer_version_id: text("answer_version_id"),
  disabled_at: text("disabled_at"),
  actor_id: text("actor_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => ({
  revisionUnique: unique("problem_binding_history_revision_unique").on(
    t.binding_id,
    t.revision,
  ),
  bindingFk: foreignKey({
    name: "problem_binding_history_binding_fk",
    columns: [t.binding_id, t.problem_id],
    foreignColumns: [
      domainProblemBindings.id,
      domainProblemBindings.problem_id,
    ],
  }),
  requiredVersionFk: foreignKey({
    name: "problem_binding_history_required_version_fk",
    columns: [t.problem_id, t.required_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  answerVersionFk: foreignKey({
    name: "problem_binding_history_answer_version_fk",
    columns: [t.problem_id, t.answer_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  policyCheck: check(
    "problem_binding_history_policy_check",
    sql`(${t.effective_version_mode} = 'any' AND ${t.required_version_id} IS NULL) OR (${t.effective_version_mode} = 'exact' AND ${t.required_version_id} IS NOT NULL)`,
  ),
  revisionCheck: check(
    "problem_binding_history_revision_check",
    sql`${t.revision} >= 0`,
  ),
}));

/** 公开题的引用授权独立于题目公开可读状态。 */
export const problemShareSettings = pgTable("problem_share_settings", {
  problem_id: text("problem_id").primaryKey().references(() => problems.id),
  enabled: boolean("enabled").notNull().default(false),
  scope: text("scope").$type<"all" | "selected">().notNull().default("all"),
  revision: integer("revision").notNull().default(0),
  updated_by: text("updated_by").notNull().references(() => users.id),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  scopeCheck: check(
    "problem_share_settings_scope_check",
    sql`${t.scope} IN ('all', 'selected')`,
  ),
  revisionCheck: check(
    "problem_share_settings_revision_check",
    sql`${t.revision} >= 0`,
  ),
}));
/** 以外键和唯一键约束定向授权目标，避免 JSON 中的失效域标识。 */
export const problemShareTargets = pgTable("problem_share_targets", {
  problem_id: text("problem_id").notNull().references(() =>
    problemShareSettings.problem_id
  ),
  domain_id: text("domain_id").notNull().references(() => domains.id),
}, (t) => ({ pk: primaryKey({ columns: [t.problem_id, t.domain_id] }) }));

/** 公开题单单独声明是否可引用；不赋予其中源题的授权。 */
export const trainingShareSettings = pgTable("training_share_settings", {
  training_id: text("training_id").primaryKey().references(() => trainings.id),
  enabled: boolean("enabled").notNull().default(false),
  scope: text("scope").$type<"all" | "selected">().notNull().default("all"),
  revision: integer("revision").notNull().default(0),
  updated_by: text("updated_by").notNull().references(() => users.id),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  scopeCheck: check(
    "training_share_settings_scope_check",
    sql`${t.scope} IN ('all', 'selected')`,
  ),
  revisionCheck: check(
    "training_share_settings_revision_check",
    sql`${t.revision} >= 0`,
  ),
}));
/** 题单定向引用授权。 */
export const trainingShareTargets = pgTable("training_share_targets", {
  training_id: text("training_id").notNull().references(() =>
    trainingShareSettings.training_id
  ),
  domain_id: text("domain_id").notNull().references(() => domains.id),
}, (t) => ({ pk: primaryKey({ columns: [t.training_id, t.domain_id] }) }));

/** 目标域引用源题单，不复制源题或支持包。 */
export const domainTrainingBindings = pgTable("domain_training_bindings", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  training_id: text("training_id").notNull().references(() => trainings.id),
  created_by: text("created_by").notNull().references(() => users.id),
  created_at: text("created_at").notNull(),
  disabled_at: text("disabled_at"),
}, (t) => ({
  identityUnique: unique("domain_training_bindings_identity_unique").on(
    t.domain_id,
    t.training_id,
  ),
  sourceIdx: index("idx_domain_training_bindings_source").on(t.training_id),
}));
