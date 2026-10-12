/** 源题及题单的基础 DDL；归属外键待工作空间表创建后统一补齐。 */
export const CATALOG_PROBLEM_BASE_DDL: string[] = [
  // 3. problems（issue #100：含 search_vector 列供 PGlite 模式测试）
  `CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    domain_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium',
    support_package_storage_url TEXT,
    samples JSONB DEFAULT '[]'::jsonb,
    oi_data_files JSONB,
    runtime_config JSONB CHECK (jsonb_typeof(runtime_config) = 'object'),
    judge_type TEXT NOT NULL DEFAULT 'dual' CHECK (judge_type IN ('dual', 'oi')),
    number INTEGER NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '0',
    type TEXT NOT NULL DEFAULT 'U' CHECK (type IN ('U', 'P')),
    is_objective BOOLEAN NOT NULL DEFAULT false,
    visibility TEXT NOT NULL DEFAULT 'public'
      CHECK (visibility IN ('public', 'private')),
    CONSTRAINT problems_p_visibility_check CHECK (type <> 'P' OR visibility = 'public'),
    submission_mode TEXT NOT NULL DEFAULT 'code'
      CHECK (submission_mode IN ('code', 'artifact')),
    artifact_max_size_mb INTEGER,
    template_content TEXT,
    llm_config JSONB,
    latest_version_id TEXT,
    effective_version_mode TEXT NOT NULL DEFAULT 'any'
      CHECK (effective_version_mode IN ('any', 'exact')),
    required_version_id TEXT,
    effective_policy_revision INTEGER NOT NULL DEFAULT 0
      CHECK (effective_policy_revision >= 0),
    CONSTRAINT problems_effective_version_policy_check CHECK (
      (effective_version_mode = 'any' AND required_version_id IS NULL)
      OR (effective_version_mode = 'exact' AND required_version_id IS NOT NULL)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple',
        coalesce(type, '') || ' ' || coalesce(number::text, '')
      ), 'B')
    ) STORED
  )`,
];
/** 题单基础 DDL，必须在源题之后、依赖题单的业务表之前执行。 */
export const CATALOG_TRAINING_BASE_DDL: string[] = [
  // 3.4 trainings（题单，issue #224）
  `CREATE TABLE IF NOT EXISTS trainings (
    id TEXT PRIMARY KEY,
    domain_id TEXT,
    public_id TEXT NOT NULL DEFAULT ('tr-' || substr(md5(random()::text),1,8)) UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS training_problems (
    training_id TEXT NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (training_id, problem_id),
    UNIQUE (training_id, position)
  )`,
];
