import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  annotationMessages,
  annotationNotifications,
  annotationOperations,
  annotationSources,
  annotationThreads,
  domainMemberships,
  submissions,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { publicUserSummary } from "../../../shared/identity/user-summary.ts";
import type { AnnotationTarget } from "../../../shared/annotation-types.ts";
import {
  domainTeacherWhere,
  loadWorkspace,
  lockActiveWorkspaceAccount,
  workspaceAudit,
} from "../../workspace/index.ts";
import { loadAnnotationTarget, parseAnnotationTarget } from "./sources.ts";
import { annotationAnchor, annotationBlocks, annotationHash } from "./text.ts";
import { annotationIsPlainText } from "../../../shared/annotation-types.ts";
import { importLegacyAnnotations } from "./legacy.ts";

type Thread = typeof annotationThreads.$inferSelect;
type Source = typeof annotationSources.$inferSelect;
type Workspace = Awaited<ReturnType<typeof loadWorkspace>>;

function teacher(workspace: Workspace) {
  return workspace.domain.preset === "education" &&
    (workspace.role === "owner" || workspace.role === "coach");
}
function bodyText(body: unknown): string {
  if (typeof body !== "string" || !body.trim() || body.length > 30000) {
    throw new BadRequestError("批注正文需要 1–30000 个字符");
  }
  return body.trim();
}
function revision(actual: number, expected: number | null) {
  if (expected === null || !Number.isSafeInteger(expected) || expected < 0) {
    throw new AppError("需要 If-Match 批注版本", 428, "REVISION_REQUIRED");
  }
  if (actual !== expected) {
    throw new ConflictError("批注已变化，请重新读取", "REVISION_CONFLICT");
  }
}
function audience(workspace: Workspace, actorId: string, shared: boolean) {
  return or(
    and(
      eq(annotationThreads.visibility, "private"),
      eq(annotationThreads.owner_id, actorId),
    ),
    shared
      ? and(
        eq(annotationThreads.visibility, "teaching"),
        teacher(workspace)
          ? undefined
          : eq(annotationThreads.student_id, actorId),
      )
      : undefined,
  );
}
function hidden(error: unknown) {
  return error instanceof AppError &&
    [401, 403, 404].includes(error.statusCode);
}

async function visibleThread(
  slug: string,
  actorId: string,
  id: string,
  governanceReason?: string,
) {
  const workspace = await loadWorkspace(slug, actorId),
    governance = governanceReason !== undefined;
  if (
    governance &&
    (!workspace.platformAdmin || !governanceReason.trim() ||
      governanceReason.length > 1000)
  ) throw new ForbiddenError("治理查询需要平台管理权限和查询原因");
  if (!governance && !workspace.membership) {
    throw new NotFoundError("批注不存在或不可访问");
  }
  if (!governance) await importLegacyAnnotations(slug, actorId, { id });
  const [row] = await getDb().select({
    thread: annotationThreads,
    source: annotationSources,
  }).from(annotationThreads)
    .innerJoin(
      annotationSources,
      and(
        eq(annotationSources.id, annotationThreads.source_id),
        eq(annotationSources.domain_id, annotationThreads.domain_id),
      ),
    )
    .where(
      and(
        eq(annotationThreads.id, id),
        eq(annotationThreads.domain_id, workspace.domain.id),
        isNull(annotationThreads.withdrawn_at),
        governance ? undefined : audience(workspace, actorId, true),
      ),
    );
  if (!row) throw new NotFoundError("批注不存在或不可访问");
  const live = await loadAnnotationTarget(
    slug,
    actorId,
    row.source.target,
    false,
    governance,
  );
  if (governance) {
    await workspaceAudit(
      getDb(),
      actorId,
      workspace.domain.id,
      "domain.update",
      {
        operation: "annotation.governance.read",
        thread_id: id,
        reason: governanceReason,
      },
    );
  }
  return { ...row, workspace, live };
}

async function userSummaries(ids: string[], executor: Executor = getDb()) {
  if (!ids.length) {
    return new Map<string, ReturnType<typeof publicUserSummary>>();
  }
  const rows = await executor.select({
    id: users.id,
    username: users.username,
    avatar_url: users.avatar_url,
    deleted_at: users.deleted_at,
  })
    .from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, publicUserSummary(row)]));
}

async function teachingStudent(
  slug: string,
  actorId: string,
  target: AnnotationTarget,
  requested?: string,
) {
  const live = await loadAnnotationTarget(slug, actorId, target, false);
  if (live.workspace.domain.preset !== "education") {
    throw new BadRequestError("只有教学域支持定向师生会话");
  }
  const student = teacher(live.workspace)
    ? (live.student_id ?? requested)
    : actorId;
  if (!student || requested && requested !== student) {
    throw new BadRequestError("请选择一名具有原文访问权的学生");
  }
  // 会话只能发给能读完整原文的人，不能通过引用授予源码或题解访问权。
  await loadAnnotationTarget(slug, student, live.target, false);
  return student;
}

async function notificationAudience(
  slug: string,
  actorId: string,
  target: AnnotationTarget,
  studentId: string | null,
) {
  if (!studentId) return [];
  const workspace = await loadWorkspace(slug, actorId);
  const rows = await getDb().select({ user_id: domainMemberships.user_id })
    .from(domainMemberships)
    .where(
      and(
        eq(domainMemberships.domain_id, workspace.domain.id),
        domainTeacherWhere(
          domainMemberships.domain_id,
          domainMemberships.user_id,
        ),
      ),
    );
  const recipients: string[] = [];
  for (const id of new Set([studentId, ...rows.map((r) => r.user_id)])) {
    if (id === actorId) continue;
    try {
      await loadAnnotationTarget(slug, id, target, false);
      recipients.push(id);
    } catch (e) {
      if (!hidden(e)) throw e;
    }
  }
  return recipients;
}

async function notify(
  tx: Executor,
  thread: Thread,
  messageId: string,
  recipients: string[],
) {
  if (!recipients.length || thread.visibility !== "teaching") return;
  await tx.insert(annotationNotifications).values(recipients.map((user_id) => ({
    id: crypto.randomUUID(),
    domain_id: thread.domain_id,
    thread_id: thread.id,
    message_id: messageId,
    user_id,
    created_at: new Date().toISOString(),
  }))).onConflictDoNothing();
}

async function operation(
  slug: string,
  actorId: string,
  name: string,
  key: string,
  input: unknown,
  perform: (tx: Executor, workspace: Workspace) => Promise<string>,
) {
  if (typeof key !== "string" || !key.trim() || key.length > 200) {
    throw new BadRequestError(
      "需要 Idempotency-Key",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const hash = await annotationHash(JSON.stringify(input));
  return await getDb().transaction(async (tx) => {
    // 同一作者的请求串行化幂等键；域共享锁与降级、移除及停用操作协调。
    await lockActiveWorkspaceAccount(tx, actorId);
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    if (!workspace.membership) {
      throw new ForbiddenError("批注需要当前域有效成员身份");
    }
    const [previous] = await tx.select().from(annotationOperations).where(and(
      eq(annotationOperations.domain_id, workspace.domain.id),
      eq(annotationOperations.actor_id, actorId),
      eq(annotationOperations.operation, name),
      eq(annotationOperations.key, key),
    ));
    if (previous) {
      if (previous.request_hash !== hash) {
        throw new ConflictError("幂等键已用于不同请求", "IDEMPOTENCY_CONFLICT");
      }
      return previous.resource_id;
    }
    const id = await perform(tx, workspace);
    await tx.insert(annotationOperations).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      actor_id: actorId,
      operation: name,
      key,
      request_hash: hash,
      resource_id: id,
      created_at: new Date().toISOString(),
    });
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: `annotation.${name}`,
      resource_id: id,
    });
    return id;
  });
}

/** 新建默认私密；教学会话必须显式选择并核验一名学生。 */
export async function createAnnotation(
  slug: string,
  actorId: string,
  key: string,
  input: {
    target: AnnotationTarget;
    content_hash: string;
    anchor: { block_id: string; start: number; end: number };
    body: string;
    visibility?: "private" | "teaching";
    student_id?: string;
  },
) {
  if (
    input.student_id !== undefined &&
    (typeof input.student_id !== "string" || !input.student_id ||
      input.student_id.length > 100)
  ) throw new BadRequestError("学生标识无效");
  const target = parseAnnotationTarget(input.target),
    body = bodyText(input.body),
    visibility = input.visibility ?? "private";
  if (!["private", "teaching"].includes(visibility)) {
    throw new BadRequestError("批注可见范围非法");
  }
  const live = await loadAnnotationTarget(slug, actorId, target);
  if (new TextEncoder().encode(live.content).length > 1024 * 1024) {
    throw new BadRequestError("批注原文不能超过 1 MiB");
  }
  const hash = await annotationHash(live.content),
    anchor = annotationAnchor(
      annotationBlocks(live.content, annotationIsPlainText(target)),
      input.anchor,
    );
  const student = visibility === "teaching"
    ? await teachingStudent(slug, actorId, live.target, input.student_id)
    : null;
  const recipients = await notificationAudience(
    slug,
    actorId,
    live.target,
    student,
  );
  const id = await operation(slug, actorId, "create", key, {
    ...input,
    target,
    body,
    visibility,
  }, async (tx, workspace) => {
    if (hash !== input.content_hash) {
      throw new ConflictError("原文已变化，请重新选择", "SOURCE_HASH_CONFLICT");
    }
    if (student && !teacher(workspace) && student !== actorId) {
      throw new ForbiddenError("教学身份已变化");
    }
    if (live.target.kind === "submission") {
      // 与删除的排他锁协调，保证固定原文不会在批注事务提交前消失。
      const [original] = await tx.select({ id: submissions.id }).from(submissions)
        .where(eq(submissions.id, live.target.submission_id)).for("share");
      if (!original) throw new NotFoundError("原提交不存在或不可访问");
    }
    const now = new Date().toISOString();
    const [inserted] = await tx.insert(annotationSources).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      target: live.target,
      target_key: live.target_key,
      content_hash: hash,
      content: live.content,
      created_at: now,
    }).onConflictDoNothing().returning();
    const source = inserted ??
      (await tx.select().from(annotationSources).where(
        and(
          eq(annotationSources.domain_id, workspace.domain.id),
          eq(annotationSources.target_key, live.target_key),
          eq(annotationSources.content_hash, hash),
        ),
      ))[0]!;
    const [thread] = await tx.insert(annotationThreads).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      source_id: source.id,
      owner_id: actorId,
      student_id: student,
      visibility,
      anchor,
      created_at: now,
      updated_at: now,
    }).returning();
    const [message] = await tx.insert(annotationMessages).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      thread_id: thread.id,
      author_id: actorId,
      body,
      created_at: now,
      updated_at: now,
    }).returning();
    await notify(tx, thread, message.id, recipients);
    return thread.id;
  });
  return await getAnnotation(slug, actorId, id);
}

/** 详情在返回消息或引用前重新校验当前来源；平台身份不隐式扩大读者范围。 */
export async function getAnnotation(
  slug: string,
  actorId: string,
  id: string,
  page = 1,
  governanceReason?: string,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("回复页码无效");
  }
  const access = await visibleThread(slug, actorId, id, governanceReason);
  const messages = await getDb().select().from(annotationMessages).where(
    eq(annotationMessages.thread_id, id),
  )
    .orderBy(asc(annotationMessages.created_at), asc(annotationMessages.id))
    .limit(50).offset((page - 1) * 50);
  const [total] = await getDb().select({
    count: sql<number>`count(*)::integer`,
  }).from(annotationMessages).where(eq(annotationMessages.thread_id, id));
  const authors = await userSummaries([
    access.thread.owner_id,
    ...messages.map((m) => m.author_id),
  ]);
  return {
    ...access.thread,
    author: authors.get(access.thread.owner_id),
    target: access.source.target,
    content_hash: access.source.content_hash,
    href: access.live.href,
    source_changed: access.source.target.kind !== "submission" &&
      await annotationHash(access.live.content) !== access.source.content_hash,
    can_reply: access.thread.visibility === "teaching" &&
      access.workspace.domain.status === "active" &&
      governanceReason === undefined,
    messages: messages.map((m) => ({
      ...m,
      body: m.withdrawn_at ? null : m.body,
      author: authors.get(m.author_id),
    })),
    page,
    per_page: 50,
    total: total.count,
  };
}

/** 完整历史原文单独按需读取；旧快照不赋予已撤销的目标访问权。 */
export async function getAnnotationOriginal(
  slug: string,
  actorId: string,
  id: string,
) {
  const access = await visibleThread(slug, actorId, id);
  return {
    target: access.source.target,
    content_hash: access.source.content_hash,
    content: access.source.content,
    blocks: annotationBlocks(
      access.source.content,
      annotationIsPlainText(access.source.target),
    ),
    href: access.live.href,
    source_changed: access.source.target.kind !== "submission" &&
      await annotationHash(access.live.content) !== access.source.content_hash,
  };
}

/** 私密笔记发送为独立会话，后续个人编辑不会悄悄同步给教师组。 */
export async function shareAnnotation(
  slug: string,
  actorId: string,
  id: string,
  key: string,
  expected: number | null,
  requestedStudent?: string,
) {
  if (
    requestedStudent !== undefined &&
    (typeof requestedStudent !== "string" || !requestedStudent ||
      requestedStudent.length > 100)
  ) throw new BadRequestError("学生标识无效");
  const access = await visibleThread(slug, actorId, id);
  if (
    access.thread.visibility !== "private" || access.thread.owner_id !== actorId
  ) throw new ForbiddenError("只能发送自己的个人笔记");
  const student = await teachingStudent(
    slug,
    actorId,
    access.source.target,
    requestedStudent,
  );
  const recipients = await notificationAudience(
    slug,
    actorId,
    access.source.target,
    student,
  );
  const newId = await operation(slug, actorId, "share", key, {
    id,
    expected,
    student,
  }, async (tx, workspace) => {
    const [current] = await tx.select().from(annotationThreads).where(
      eq(annotationThreads.id, id),
    ).for("update");
    revision(current.revision, expected);
    if (current.withdrawn_at || !teacher(workspace) && student !== actorId) {
      throw new NotFoundError("批注不存在或教学身份已变化");
    }
    const [first] = await tx.select().from(annotationMessages).where(
      and(
        eq(annotationMessages.thread_id, id),
        isNull(annotationMessages.withdrawn_at),
      ),
    ).orderBy(asc(annotationMessages.created_at)).limit(1);
    if (!first) throw new NotFoundError("个人笔记已撤回");
    const now = new Date().toISOString();
    const [thread] = await tx.insert(annotationThreads).values({
      id: crypto.randomUUID(),
      domain_id: current.domain_id,
      source_id: current.source_id,
      owner_id: actorId,
      student_id: student,
      visibility: "teaching",
      anchor: current.anchor,
      created_at: now,
      updated_at: now,
    }).returning();
    const [message] = await tx.insert(annotationMessages).values({
      id: crypto.randomUUID(),
      domain_id: current.domain_id,
      thread_id: thread.id,
      author_id: actorId,
      body: first.body,
      created_at: now,
      updated_at: now,
    }).returning();
    await notify(tx, thread, message.id, recipients);
    return thread.id;
  });
  return await getAnnotation(slug, actorId, newId);
}

/** 回复只存在于定向会话；幂等重试不会额外生成消息或通知。 */
export async function replyAnnotation(
  slug: string,
  actorId: string,
  id: string,
  key: string,
  body: string,
) {
  const access = await visibleThread(slug, actorId, id), value = bodyText(body);
  if (access.thread.visibility !== "teaching") {
    throw new BadRequestError("个人笔记不提供共享回复");
  }
  const recipients = await notificationAudience(
    slug,
    actorId,
    access.source.target,
    access.thread.student_id,
  );
  await operation(
    slug,
    actorId,
    "reply",
    key,
    { id, body: value },
    async (tx, workspace) => {
      const [thread] = await tx.select().from(annotationThreads).where(
        and(
          eq(annotationThreads.id, id),
          audience(workspace, actorId, true),
          isNull(annotationThreads.withdrawn_at),
        ),
      ).for("update");
      if (!thread) throw new NotFoundError("会话不存在或不可访问");
      const now = new Date().toISOString();
      const [message] = await tx.insert(annotationMessages).values({
        id: crypto.randomUUID(),
        domain_id: thread.domain_id,
        thread_id: id,
        author_id: actorId,
        body: value,
        created_at: now,
        updated_at: now,
      }).returning();
      await tx.update(annotationThreads).set({
        updated_at: now,
        revision: thread.revision + 1,
        state: "open",
      }).where(eq(annotationThreads.id, id));
      await notify(tx, thread, message.id, recipients);
      return message.id;
    },
  );
  return await getAnnotation(slug, actorId, id);
}

/** 作者可以编辑或撤回消息；教师组不能改写其他人的原文。 */
export async function updateAnnotationMessage(
  slug: string,
  actorId: string,
  id: string,
  messageId: string,
  expected: number | null,
  input: { body?: string; withdraw?: boolean },
) {
  await visibleThread(slug, actorId, id);
  const value = input.withdraw === true ? undefined : bodyText(input.body);
  await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    const [thread] = await tx.select().from(annotationThreads).where(
      and(
        eq(annotationThreads.id, id),
        eq(annotationThreads.domain_id, workspace.domain.id),
        audience(workspace, actorId, true),
        isNull(annotationThreads.withdrawn_at),
      ),
    ).for("update");
    if (!workspace.membership || !thread) {
      throw new NotFoundError("批注不存在或不可访问");
    }
    const [message] = await tx.select().from(annotationMessages).where(
      and(
        eq(annotationMessages.thread_id, id),
        eq(annotationMessages.id, messageId),
        eq(annotationMessages.author_id, actorId),
        isNull(annotationMessages.withdrawn_at),
      ),
    ).for("update");
    if (!message) throw new ForbiddenError("只能修改或撤回本人消息");
    revision(message.revision, expected);
    const now = new Date().toISOString();
    await tx.update(annotationMessages).set({
      ...(value === undefined ? { withdrawn_at: now } : { body: value }),
      updated_at: now,
      revision: message.revision + 1,
    }).where(eq(annotationMessages.id, messageId));
    await tx.update(annotationThreads).set({
      updated_at: now,
      revision: thread.revision + 1,
    }).where(eq(annotationThreads.id, id));
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "annotation.message.update",
      thread_id: id,
      message_id: messageId,
      withdrawn: value === undefined,
    });
  });
  return await getAnnotation(slug, actorId, id);
}

/** 会话可重新打开；撤回他人教学会话需要现任教练身份及明确治理原因。 */
export async function updateAnnotationThread(
  slug: string,
  actorId: string,
  id: string,
  expected: number | null,
  input: { state?: "open" | "resolved"; withdraw?: boolean; reason?: string },
) {
  await visibleThread(slug, actorId, id);
  if (
    input.withdraw !== true && !["open", "resolved"].includes(input.state ?? "")
  ) throw new BadRequestError("需要有效的会话状态");
  await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    const [thread] = await tx.select().from(annotationThreads).where(
      and(
        eq(annotationThreads.id, id),
        eq(annotationThreads.domain_id, workspace.domain.id),
        audience(workspace, actorId, true),
        isNull(annotationThreads.withdrawn_at),
      ),
    ).for("update");
    if (!workspace.membership || !thread) {
      throw new NotFoundError("批注不存在或不可访问");
    }
    revision(thread.revision, expected);
    if (
      input.withdraw && thread.owner_id !== actorId &&
      !(thread.visibility === "teaching" && teacher(workspace) &&
        typeof input.reason === "string" && input.reason.trim() &&
        input.reason.length <= 1000)
    ) throw new ForbiddenError("撤回他人教学会话需要现任教练身份和原因");
    const now = new Date().toISOString();
    await tx.update(annotationThreads).set({
      ...(input.withdraw ? { withdrawn_at: now } : { state: input.state }),
      updated_at: now,
      revision: thread.revision + 1,
    }).where(eq(annotationThreads.id, id));
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "annotation.thread.update",
      thread_id: id,
      state: input.state,
      withdrawn: input.withdraw === true,
      reason: input.reason,
    });
  });
  return input.withdraw
    ? { id, withdrawn: true }
    : await getAnnotation(slug, actorId, id);
}

/** 目录用游标分页；原文授权失败的记录不进入结果、游标或数量。 */
export async function listAnnotations(
  slug: string,
  actorId: string,
  options: {
    shared?: boolean;
    teachingOnly?: boolean;
    target?: AnnotationTarget;
    submissionId?: string;
    cursor?: string;
    limit?: number;
  } = {},
) {
  const workspace = await loadWorkspace(slug, actorId);
  if (!workspace.membership) {
    throw new NotFoundError("批注需要当前域有效成员身份");
  }
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new BadRequestError("批注分页大小无效");
  }
  const target = options.target
    ? await loadAnnotationTarget(slug, actorId, options.target, false)
    : null;
  if (options.shared && (!target || target.target.kind === "submission")) {
    await importLegacyAnnotations(slug, actorId, {
      submissionId: target?.target.kind === "submission"
        ? target.target.submission_id
        : options.submissionId,
    });
  }
  let cursor: Thread | undefined;
  if (options.cursor) {
    cursor = (await visibleThread(slug, actorId, options.cursor)).thread;
  }
  const allowed: Array<{ thread: Thread; source: Source }> = [];
  const checked = new Map<string, boolean>();
  for (;;) {
    const rows = await getDb().select({
      thread: annotationThreads,
      source: annotationSources,
    }).from(annotationThreads)
      .innerJoin(
        annotationSources,
        and(
          eq(annotationSources.id, annotationThreads.source_id),
          eq(annotationSources.domain_id, annotationThreads.domain_id),
        ),
      )
      .where(
        and(
          eq(annotationThreads.domain_id, workspace.domain.id),
          isNull(annotationThreads.withdrawn_at),
          audience(workspace, actorId, options.shared === true),
          options.teachingOnly
            ? eq(annotationThreads.visibility, "teaching")
            : undefined,
          target
            ? eq(annotationSources.target_key, target.target_key)
            : undefined,
          options.submissionId
            ? sql`${annotationSources.target}->>'kind' = 'submission' AND ${annotationSources.target}->>'submission_id' = ${options.submissionId}`
            : undefined,
          cursor
            ? or(
              lt(annotationThreads.created_at, cursor.created_at),
              and(
                eq(annotationThreads.created_at, cursor.created_at),
                lt(annotationThreads.id, cursor.id),
              ),
            )
            : undefined,
        ),
      )
      .orderBy(desc(annotationThreads.created_at), desc(annotationThreads.id))
      .limit(50);
    if (!rows.length) break;
    for (const row of rows) {
      const cacheKey = row.source.target_key;
      if (!checked.has(cacheKey)) {
        try {
          await loadAnnotationTarget(slug, actorId, row.source.target, false);
          checked.set(cacheKey, true);
        } catch (e) {
          if (!hidden(e)) throw e;
          checked.set(cacheKey, false);
        }
      }
      if (checked.get(cacheKey)) allowed.push(row);
      if (allowed.length > limit) break;
    }
    if (allowed.length > limit || rows.length < 50) break;
    cursor = rows.at(-1)!.thread;
  }
  const authors = await userSummaries(
    allowed.slice(0, limit).map((r) => r.thread.owner_id),
  );
  return {
    actor_id: actorId,
    domain_slug: slug,
    data: allowed.slice(0, limit).map(({ thread, source }) => ({
      id: thread.id,
      visibility: thread.visibility,
      owner_id: thread.owner_id,
      student_id: thread.student_id,
      author: authors.get(thread.owner_id),
      state: thread.state,
      revision: thread.revision,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      target: source.target,
      content_hash: source.content_hash,
      anchor: { ...thread.anchor, before: undefined, after: undefined },
    })),
    next_cursor: allowed.length > limit ? allowed[limit - 1]!.thread.id : null,
  };
}

/** 通知与未读数只包含现在仍能访问的会话，不使用持久摘要绕过撤权。 */
export async function annotationInbox(slug: string, actorId: string, options: { cursor?: string; limit?: number } = {}) {
  const workspace = await loadWorkspace(slug, actorId), limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestError("通知分页大小无效");
  const empty = { actor_id: actorId, domain_slug: slug, data: [], unread_count: 0, next_cursor: null };
  if (!workspace.membership) return empty;
  const db = getDb();
  const eligible = db.select({
    id: annotationNotifications.id, thread_id: annotationNotifications.thread_id,
    domain_id: annotationNotifications.domain_id, message_id: annotationNotifications.message_id,
    user_id: annotationNotifications.user_id, created_at: annotationNotifications.created_at,
    read_at: annotationNotifications.read_at, target: annotationSources.target, target_key: annotationSources.target_key,
  }).from(annotationNotifications)
    .innerJoin(annotationThreads, and(eq(annotationThreads.id, annotationNotifications.thread_id), eq(annotationThreads.domain_id, annotationNotifications.domain_id)))
    .innerJoin(annotationSources, and(eq(annotationSources.id, annotationThreads.source_id), eq(annotationSources.domain_id, annotationThreads.domain_id)))
    .where(and(eq(annotationNotifications.domain_id, workspace.domain.id), eq(annotationNotifications.user_id, actorId),
      isNull(annotationThreads.withdrawn_at), audience(workspace, actorId, true))).as("eligible_annotation_notifications");
  // 先按原文合并计数，只加载每种来源一条元数据；不把全部历史通知搬进内存。
  const groups = await db.select({ target: eligible.target, target_key: eligible.target_key,
    unread: sql<number>`(count(*) FILTER (WHERE ${eligible.read_at} IS NULL))::integer`,
  }).from(eligible).groupBy(eligible.target, eligible.target_key);
  const allowed: string[] = [];
  let unread = 0;
  for (const group of groups) {
    try {
      await loadAnnotationTarget(slug, actorId, group.target, false);
      allowed.push(group.target_key); unread += group.unread;
    } catch (error) { if (!hidden(error)) throw error; }
  }
  if (!allowed.length) {
    if (options.cursor) throw new NotFoundError("通知游标不存在或不可访问");
    return empty;
  }
  let cursor: { id: string; created_at: string } | undefined;
  if (options.cursor) {
    [cursor] = await db.select({ id: eligible.id, created_at: eligible.created_at }).from(eligible)
      .where(and(eq(eligible.id, options.cursor), inArray(eligible.target_key, allowed)));
    if (!cursor) throw new NotFoundError("通知游标不存在或不可访问");
  }
  const data = await db.select({
    id: eligible.id, domain_id: eligible.domain_id, thread_id: eligible.thread_id,
    message_id: eligible.message_id, user_id: eligible.user_id, created_at: eligible.created_at, read_at: eligible.read_at,
  }).from(eligible).where(and(inArray(eligible.target_key, allowed), cursor
    ? or(lt(eligible.created_at, cursor.created_at), and(eq(eligible.created_at, cursor.created_at), lt(eligible.id, cursor.id))) : undefined))
    .orderBy(desc(eligible.created_at), desc(eligible.id)).limit(limit + 1);
  return { actor_id: actorId, domain_slug: slug, data: data.slice(0, limit), unread_count: unread,
    next_cursor: data.length > limit ? data[limit - 1]!.id : null };
}

/** 已读操作同样验证当前会话，历史通知 ID 不成为读取旁路。 */
export async function markAnnotationRead(
  slug: string,
  actorId: string,
  id: string,
) {
  const access = await visibleThread(slug, actorId, id);
  await getDb().update(annotationNotifications).set({
    read_at: new Date().toISOString(),
  }).where(
    and(
      eq(annotationNotifications.domain_id, access.workspace.domain.id),
      eq(annotationNotifications.thread_id, id),
      eq(annotationNotifications.user_id, actorId),
    ),
  );
  return { read: true };
}

/** 教练选择定向学生，只返回已有域成员且有原文访问权的身份摘要。 */
export async function annotationRecipients(
  slug: string,
  actorId: string,
  target: AnnotationTarget,
  keyword = "",
) {
  const workspace = await loadWorkspace(slug, actorId);
  if (!teacher(workspace)) {
    throw new ForbiddenError("只有现任域教练可以选择教学批注对象");
  }
  if (typeof keyword !== "string" || keyword.length > 100) {
    throw new BadRequestError("用户名搜索最多 100 个字符");
  }
  await loadAnnotationTarget(slug, actorId, target, false);
  const rows = await getDb().select({
    id: users.id,
    username: users.username,
    avatar_url: users.avatar_url,
  }).from(users)
    .innerJoin(
      domainMemberships,
      and(
        eq(domainMemberships.user_id, users.id),
        eq(domainMemberships.domain_id, workspace.domain.id),
      ),
    )
    .where(
      and(
        eq(domainMemberships.status, "active"),
        isNull(users.deleted_at),
        keyword.trim()
          ? ilike(users.username, `%${keyword.trim()}%`)
          : undefined,
      ),
    ).orderBy(asc(users.username)).limit(20);
  const result: ReturnType<typeof publicUserSummary>[] = [];
  for (const row of rows) {
    try {
      await loadAnnotationTarget(slug, row.id, target, false);
      result.push(publicUserSummary(row));
    } catch (e) {
      if (!hidden(e)) throw e;
    }
  }
  return result;
}
