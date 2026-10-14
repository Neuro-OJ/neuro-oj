import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { classrooms } from "./education.ts";
import { submissions } from "./submission.ts";
import { users } from "./identity.ts";

/** 批注固定在原提交的文本哈希及行范围，保留作者和撤回依据。 */
export const submissionAnnotations = pgTable("submission_annotations", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  classroom_id: text("classroom_id").notNull(),
  submission_id: text("submission_id").notNull(),
  user_id: text("user_id").notNull(),
  author_id: text("author_id").notNull().references(() => users.id),
  file_name: text("file_name").notNull(),
  source_hash: text("source_hash").notNull(),
  start_line: integer("start_line").notNull(),
  end_line: integer("end_line").notNull(),
  body: text("body").notNull(),
  revision: integer("revision").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  deleted_at: text("deleted_at"),
}, (t) => ({
  classroomFk: foreignKey({
    name: "submission_annotations_classroom_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  sourceFk: foreignKey({
    name: "submission_annotations_source_fk",
    columns: [t.domain_id, t.submission_id, t.user_id],
    foreignColumns: [
      submissions.domain_id,
      submissions.id,
      submissions.user_id,
    ],
  }),
  lines: check(
    "submission_annotations_lines_check",
    sql`${t.start_line} >= 1 AND ${t.end_line} >= ${t.start_line}`,
  ),
  hash: check(
    "submission_annotations_hash_check",
    sql`${t.source_hash} ~ '^[a-f0-9]{64}$'`,
  ),
  body: check(
    "submission_annotations_body_check",
    sql`char_length(${t.body}) BETWEEN 1 AND 30000`,
  ),
  revision: check(
    "submission_annotations_revision_check",
    sql`${t.revision} >= 0`,
  ),
  sourceIdx: index("idx_submission_annotations_source").on(
    t.domain_id,
    t.classroom_id,
    t.submission_id,
    t.created_at,
  ),
}));
