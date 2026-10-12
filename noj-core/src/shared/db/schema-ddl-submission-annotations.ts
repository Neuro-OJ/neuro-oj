/** 行批注 DDL 与生成迁移一致，组合键阻止错域和错学生引用。 */
export const SUBMISSION_ANNOTATIONS_DDL = [
  `ALTER TABLE submissions ADD CONSTRAINT submissions_teaching_source_unique UNIQUE (domain_id, id, user_id)`,
  `CREATE TABLE IF NOT EXISTS submission_annotations (
    id TEXT PRIMARY KEY NOT NULL,
    domain_id TEXT NOT NULL,
    classroom_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id),
    file_name TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    body TEXT NOT NULL,
    revision INTEGER DEFAULT 0 NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CONSTRAINT submission_annotations_classroom_fk FOREIGN KEY (domain_id, classroom_id) REFERENCES classrooms(domain_id, id),
    CONSTRAINT submission_annotations_source_fk FOREIGN KEY (domain_id, submission_id, user_id) REFERENCES submissions(domain_id, id, user_id),
    CONSTRAINT submission_annotations_lines_check CHECK (start_line >= 1 AND end_line >= start_line),
    CONSTRAINT submission_annotations_hash_check CHECK (source_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT submission_annotations_body_check CHECK (char_length(body) BETWEEN 1 AND 30000),
    CONSTRAINT submission_annotations_revision_check CHECK (revision >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_submission_annotations_source ON submission_annotations(domain_id, classroom_id, submission_id, created_at)`,
];
/** 测试清理包含批注，不遗留对提交的历史引用。 */
export const SUBMISSION_ANNOTATIONS_TABLES = [
  "submission_annotations",
] as const;
