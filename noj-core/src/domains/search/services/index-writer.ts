import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { unwrapFirstRow, unwrapRows } from "../../../shared/base/sql-rows.ts";
import { searchEntries } from "../../../shared/db/schema.ts";
import type { SearchEntryInput } from "../types.ts";

export async function upsertSearchEntry(
  input: SearchEntryInput,
  // deno-lint-ignore no-explicit-any
  db: any = getDb(),
): Promise<void> {
  const domainId = input.domainId === undefined
    ? await resolveSearchEntryDomain(input.entityType, input.entityId, db)
    : input.domainId;
  await db
    .insert(searchEntries)
    .values({
      entity_type: input.entityType,
      entity_id: input.entityId,
      domain_id: domainId,
      title: input.title,
      body: input.body,
      metadata: input.metadata,
      owner_id: input.ownerId ?? null,
      participant_ids: input.participantIds ?? [],
      deleted_by_user_ids: input.deletedByUserIds ?? [],
      is_public: input.isPublic,
      admin_only: input.adminOnly ?? false,
      is_active: input.isActive ?? true,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [searchEntries.entity_type, searchEntries.entity_id],
      set: {
        domain_id: domainId,
        title: input.title,
        body: input.body,
        metadata: input.metadata,
        owner_id: input.ownerId ?? null,
        participant_ids: input.participantIds ?? [],
        deleted_by_user_ids: input.deletedByUserIds ?? [],
        is_public: input.isPublic,
        admin_only: input.adminOnly ?? false,
        is_active: input.isActive ?? true,
        updated_at: input.updatedAt,
      },
    });
}

/** 资源索引归属由源记录确定，账号与平台公告保留实例级关系。 */
async function resolveSearchEntryDomain(
  type: string,
  id: string,
  db: Executor,
): Promise<string | null> {
  const query = type === "problem"
    ? sql`SELECT domain_id FROM problems WHERE id=${id}`
    : type === "contest"
    ? sql`SELECT domain_id FROM contests WHERE id=${id}`
    : type === "community_post"
    ? sql`SELECT domain_id FROM community_posts WHERE id=${id}`
    : type === "community_comment"
    ? sql`SELECT domain_id FROM community_comments WHERE id=${id}`
    : type === "submission"
    ? sql`SELECT domain_id FROM submissions WHERE id=${id}`
    : null;
  if (!query) return null;
  const rows = await db.execute(query);
  return unwrapFirstRow<{ domain_id: string | null }>(rows as never)
    ?.domain_id ?? null;
}

export async function deleteSearchEntry(
  entityType: string,
  entityId: string,
  // deno-lint-ignore no-explicit-any
  db: any = getDb(),
): Promise<void> {
  await db.delete(searchEntries).where(
    sql`${searchEntries.entity_type} = ${entityType} AND ${searchEntries.entity_id} = ${entityId}`,
  );
}

/**
 * 构造题目的搜索索引条目。
 *
 * @param db 可传入**事务执行器**：发布事务内需要把索引写入与版本提交原子化
 *   （否则"已发布但索引永久缺失"，tracking #23）。
 */
export async function buildProblemEntry(
  id: string,
  db: Executor = getDb(),
): Promise<SearchEntryInput | null> {
  const rows = await db.execute<{
    id: string;
    domain_id: string;
    title: string;
    description: string;
    difficulty: string;
    number: number;
    source_slug: string;
    owner_id: string;
    visibility: string;
    created_at: string;
    updated_at: string;
    tags: string | null;
  }>(sql`
    SELECT p.id, p.domain_id, p.title, p.description, p.difficulty, p.number,
           coalesce(source.slug, 'main') AS source_slug,
           p.owner_id, p.visibility, p.created_at, p.updated_at,
           COALESCE((
             SELECT string_agg(t.name, ' ' ORDER BY t.name)
             FROM problem_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE pt.problem_id = p.id
           ), '') AS tags
    FROM problems p
    LEFT JOIN domains source ON source.id = p.domain_id
    -- 只索引**已发布**题目（Handbook §3.5/§6.6）：草稿内容不进公开索引；
    -- 未发布题目对普通访问者本就不存在，索引出现行等于泄露存在性
    WHERE p.id = ${id} AND p.latest_version_id IS NOT NULL
  `);
  const row = unwrapFirstRow<{
    id: string;
    domain_id: string;
    title: string;
    description: string;
    difficulty: string;
    number: number;
    source_slug: string;
    owner_id: string;
    visibility: string;
    created_at: string;
    updated_at: string;
    tags: string | null;
  }>(rows as never);
  if (!row) return null;
  const displayId = String(row.number),
    qualifiedRef = `${row.source_slug}:${row.number}`;
  return {
    entityType: "problem",
    entityId: row.id,
    domainId: row.domain_id,
    title: row.title,
    body: `${row.description} ${qualifiedRef} ${row.tags ?? ""}`.trim(),
    metadata: {
      display_id: displayId,
      difficulty: row.difficulty,
      qualified_ref: qualifiedRef,
      source_domain_slug: row.source_slug,
      number: row.number,
      tags: row.tags ? row.tags.split(" ") : [],
    },
    ownerId: row.owner_id,
    isPublic: row.visibility === "public",
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildUserEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    username: string;
    email: string;
    bio: string;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, username, email, bio, deleted_at, created_at, updated_at
    FROM users
    WHERE id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    username: string;
    email: string;
    bio: string;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(rows as never);
  if (!row) return null;
  // root 系统用户不进入搜索索引（与既有用户搜索排除 root 的行为一致）。
  if (row.id === ROOT_USER_ID) return null;
  return {
    entityType: "user",
    entityId: row.id,
    title: row.username,
    body: `${row.email} ${row.bio}`.trim(),
    metadata: { username: row.username, email: row.email },
    ownerId: null,
    isPublic: false,
    adminOnly: true,
    isActive: row.deleted_at === null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildCommunityPostEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    domain_id: string;
    public_id: string;
    type: string;
    title: string | null;
    content: string;
    author_id: string;
    problem_id: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    source_domain_slug: string | null;
    problem_number: number | null;
    problem_title: string | null;
  }>(sql`
    SELECT p.id, p.domain_id, p.public_id, p.type, p.title, p.content, p.author_id,
           p.problem_id, p.status, p.created_at, p.updated_at,
           u.username AS author_username,
           coalesce(source.slug, 'main') AS source_domain_slug, pr.number AS problem_number,
           pr.title AS problem_title
    FROM community_posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN problems pr ON pr.id = p.problem_id
    LEFT JOIN domains source ON source.id = pr.domain_id
    WHERE p.id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    domain_id: string;
    public_id: string;
    type: string;
    title: string | null;
    content: string;
    author_id: string;
    problem_id: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    source_domain_slug: string | null;
    problem_number: number | null;
    problem_title: string | null;
  }>(rows as never);
  if (!row) return null;
  if (
    row.status !== "published" ||
    (row.type !== "solution" && row.type !== "discussion")
  ) {
    return null;
  }
  const problemText = row.problem_title
    ? `${row.source_domain_slug}:${row.problem_number} ${row.problem_title}`
    : "";
  return {
    entityType: "community_post",
    entityId: row.id,
    domainId: row.domain_id,
    title: row.title ?? row.content.slice(0, 50),
    body: `${row.content} ${row.author_username} ${problemText}`.trim(),
    metadata: {
      public_id: row.public_id,
      post_type: row.type,
      author_id: row.author_id,
      author_username: row.author_username,
      problem_id: row.problem_id,
    },
    ownerId: row.author_id,
    isPublic: true,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildCommunityCommentEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    content: string;
    author_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    post_id: string;
    post_title: string | null;
    post_status: string;
    post_public_id: string;
  }>(sql`
    SELECT c.id, c.content, c.author_id, c.status, c.created_at, c.updated_at,
           u.username AS author_username,
           p.id AS post_id, p.title AS post_title, p.status AS post_status,
           p.public_id AS post_public_id
    FROM community_comments c
    JOIN users u ON u.id = c.author_id
    JOIN community_posts p ON p.id = c.post_id
    WHERE c.id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    content: string;
    author_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    author_username: string;
    post_id: string;
    post_title: string | null;
    post_status: string;
    post_public_id: string;
  }>(rows as never);
  if (!row) return null;
  if (row.status !== "published" || row.post_status !== "published") {
    return null;
  }
  return {
    entityType: "community_comment",
    entityId: row.id,
    title: row.content.slice(0, 50),
    body: `${row.content} ${row.author_username} ${row.post_title ?? ""}`
      .trim(),
    metadata: {
      author_id: row.author_id,
      author_username: row.author_username,
      post_id: row.post_id,
      post_title: row.post_title,
      post_public_id: row.post_public_id,
    },
    ownerId: row.author_id,
    isPublic: true,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildContestEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    title: string;
    description: string;
    kind: string;
    is_public: boolean;
    created_at: string;
    updated_at: string;
    participant_ids: string[];
  }>(sql`
    SELECT c.id, c.public_id, c.title, c.description, c.kind, c.is_public,
           c.created_at, c.updated_at,
           COALESCE((
             SELECT array_agg(user_id)
             FROM contest_participants cp
             WHERE cp.contest_id = c.id
           ), '{}') AS participant_ids
    FROM contests c
    WHERE c.id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    public_id: string;
    title: string;
    description: string;
    kind: string;
    is_public: boolean;
    created_at: string;
    updated_at: string;
    participant_ids: string[];
  }>(rows as never);
  if (!row) return null;
  return {
    entityType: "contest",
    entityId: row.id,
    title: row.title,
    body: row.description,
    metadata: {
      public_id: row.public_id,
      kind: row.kind,
      is_public: row.is_public,
    },
    ownerId: null,
    participantIds: row.participant_ids,
    isPublic: row.is_public,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function buildSubmissionEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    user_id: string;
    problem_id: string;
    language: string;
    status: string;
    created_at: string;
    problem_title: string;
    source_domain_slug: string;
    problem_number: number;
    submitter_username: string;
  }>(sql`
    SELECT s.id, s.public_id, s.user_id, s.problem_id, s.language, s.status,
           s.created_at,
           p.title AS problem_title, coalesce(source.slug, 'main') AS source_domain_slug, p.number AS problem_number,
           u.username AS submitter_username
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN domains source ON source.id = p.domain_id
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    public_id: string;
    user_id: string;
    problem_id: string;
    language: string;
    status: string;
    created_at: string;
    problem_title: string;
    source_domain_slug: string;
    problem_number: number;
    submitter_username: string;
  }>(rows as never);
  if (!row) return null;
  const displayId = `${row.source_domain_slug}:${row.problem_number}`;
  return {
    entityType: "submission",
    entityId: row.id,
    title: `${row.problem_title} - ${row.submitter_username}`,
    body: `${row.language} ${row.status} ${row.problem_title} ${displayId}`
      .trim(),
    metadata: {
      public_id: row.public_id,
      problem_id: row.problem_id,
      language: row.language,
      status: row.status,
      submitted_at: row.created_at,
    },
    ownerId: row.user_id,
    isPublic: false,
    adminOnly: false,
    isActive: true,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

export async function buildMessageEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    recalled_at: string | null;
    created_at: string;
    user1_id: string;
    user2_id: string;
    user1_username: string;
    user2_username: string;
    deleted_by_user_ids: string[];
  }>(sql`
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.recalled_at,
           m.created_at,
           c.user1_id, c.user2_id,
           u1.username AS user1_username, u2.username AS user2_username,
           COALESCE((
             SELECT array_agg(md.user_id)
             FROM message_deletions md
             WHERE md.message_id = m.id
           ), '{}') AS deleted_by_user_ids
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u1 ON u1.id = c.user1_id
    JOIN users u2 ON u2.id = c.user2_id
    WHERE m.id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    recalled_at: string | null;
    created_at: string;
    user1_id: string;
    user2_id: string;
    user1_username: string;
    user2_username: string;
    deleted_by_user_ids: string[];
  }>(rows as never);
  if (!row) return null;
  return {
    entityType: "message",
    entityId: row.id,
    title: `与 ${row.user1_username} / ${row.user2_username} 的私信`,
    body: `${row.content} ${row.user1_username} ${row.user2_username}`.trim(),
    metadata: {
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      sent_at: row.created_at,
    },
    ownerId: null,
    participantIds: [row.user1_id, row.user2_id],
    deletedByUserIds: row.deleted_by_user_ids,
    isPublic: false,
    adminOnly: false,
    isActive: row.recalled_at === null,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

export async function buildAnnouncementEntry(
  id: string,
): Promise<SearchEntryInput | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    public_id: string;
    title: string;
    content: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, public_id, title, content, is_active, created_at, updated_at
    FROM announcements
    WHERE id = ${id}
  `);
  const row = unwrapFirstRow<{
    id: string;
    public_id: string;
    title: string;
    content: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>(rows as never);
  if (!row) return null;
  return {
    entityType: "announcement",
    entityId: row.id,
    title: row.title,
    body: row.content,
    metadata: { public_id: row.public_id },
    ownerId: null,
    isPublic: row.is_active,
    adminOnly: false,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BUILDERS: Record<
  string,
  (id: string) => Promise<SearchEntryInput | null>
> = {
  problem: buildProblemEntry,
  user: buildUserEntry,
  community_post: buildCommunityPostEntry,
  community_comment: buildCommunityCommentEntry,
  contest: buildContestEntry,
  submission: buildSubmissionEntry,
  message: buildMessageEntry,
  announcement: buildAnnouncementEntry,
};

export async function processSearchIndexEvent(
  entityType: string,
  entityId: string,
  action: "upsert" | "delete",
): Promise<void> {
  const builder = BUILDERS[entityType];
  if (!builder) {
    throw new Error(`未知搜索实体类型: ${entityType}`);
  }
  if (action === "delete") {
    const current = await builder(entityId);
    if (current) {
      await upsertSearchEntry(current);
    } else {
      await deleteSearchEntry(entityType, entityId);
    }
    return;
  }
  const entry = await builder(entityId);
  if (entry) {
    await upsertSearchEntry(entry);
  } else {
    await deleteSearchEntry(entityType, entityId);
  }
}

export async function reindexAll(): Promise<Record<string, number>> {
  const db = getDb();
  const counts: Record<string, number> = {};

  async function reindexType(
    entityType: string,
    builder: (id: string) => Promise<SearchEntryInput | null>,
    // deno-lint-ignore no-explicit-any
    tx: any,
  ): Promise<void> {
    const table = entityTypeToTable(entityType);
    const rows = await tx.execute(
      sql`SELECT id FROM ${table}`,
    ) as { id: string }[] | { rows: { id: string }[] };
    const ids = unwrapRows<{ id: string }>(rows as never);
    const existingRows = (await tx
      .select({ entityId: searchEntries.entity_id })
      .from(searchEntries)
      .where(sql`${searchEntries.entity_type} = ${entityType}`)) as {
        entityId: string;
      }[];
    const existingIds = new Set(existingRows.map((r) => r.entityId));
    const keptIds = new Set<string>();
    let count = 0;
    for (const row of ids) {
      const entry = await builder(row.id);
      if (entry) {
        await upsertSearchEntry(entry, tx);
        keptIds.add(row.id);
        count++;
      }
    }
    // 只清理本次未被重建的旧索引；不依赖外层事务，避免测试事务下挂起。
    for (const existingId of existingIds) {
      if (!keptIds.has(existingId)) {
        await deleteSearchEntry(entityType, existingId, tx);
      }
    }
    counts[entityType] = count;
  }

  for (const [entityType, builder] of Object.entries(BUILDERS)) {
    await reindexType(entityType, builder, db);
  }
  return counts;
}

function entityTypeToTable(entityType: string): ReturnType<typeof sql> {
  const map: Record<string, ReturnType<typeof sql>> = {
    problem: sql`problems`,
    user: sql`users`,
    community_post: sql`community_posts`,
    community_comment: sql`community_comments`,
    contest: sql`contests`,
    submission: sql`submissions`,
    message: sql`messages`,
    announcement: sql`announcements`,
  };
  const table = map[entityType];
  if (!table) throw new Error(`未知搜索实体类型: ${entityType}`);
  return table;
}
