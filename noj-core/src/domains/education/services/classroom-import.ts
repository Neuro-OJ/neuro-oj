import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classroomMemberships,
  domainInvitations,
  domainMemberships,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
} from "../../../shared/base/errors.ts";
import { assertInstanceAccountNotBanned } from "../../identity/index.ts";
import {
  createDomainInvitation,
  loadWorkspace,
  workspaceAudit,
} from "../../workspace/index.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";
import { joinInvitedClassroom } from "./invitations.ts";
import { educationOperation, educationRequestHash } from "./operations.ts";
import {
  type ClassroomImportEntry,
  parseClassroomImport,
} from "./import-input.ts";

type ImportAction =
  | "join"
  | "invite"
  | "replace_invite"
  | "already_member"
  | "already_invited"
  | "error";
/** 预览只返回匹配账号的最小身份及逐行计划，没有账号凭据或旧邀请令牌。 */
export interface ClassroomImportRow extends ClassroomImportEntry {
  action: ImportAction;
  user_id: string | null;
  matched_username: string | null;
  invitation_ids: string[];
}

async function rowsFor(
  executor: Executor,
  domainId: string,
  classroomId: string,
  entries: ClassroomImportEntry[],
  replace: boolean,
  canInviteDomain: boolean,
) {
  const emails = entries.map((e) => e.email).filter(Boolean),
    names = entries.map((e) => e.username).filter(Boolean);
  const accounts = emails.length || names.length
    ? await executor.select({
      id: users.id,
      username: users.username,
      email: users.email,
      deleted_at: users.deleted_at,
      domain_status: domainMemberships.status,
      class_role: classroomMemberships.role,
      class_status: classroomMemberships.status,
    })
      .from(users).leftJoin(
        domainMemberships,
        and(
          eq(domainMemberships.user_id, users.id),
          eq(domainMemberships.domain_id, domainId),
        ),
      )
      .leftJoin(
        classroomMemberships,
        and(
          eq(classroomMemberships.user_id, users.id),
          eq(classroomMemberships.classroom_id, classroomId),
        ),
      )
      .where(
        and(
          or(
            emails.length
              ? inArray(sql`lower(${users.email})`, emails)
              : undefined,
            names.length ? inArray(users.username, names) : undefined,
          ),
          canInviteDomain ? undefined : eq(domainMemberships.status, "active"),
        ),
      )
    : [];
  const inviteEmails = [
    ...new Set([...emails, ...accounts.map((a) => a.email.toLowerCase())]),
  ];
  const invitations = inviteEmails.length
    ? await executor.select().from(domainInvitations).where(and(
      eq(domainInvitations.domain_id, domainId),
      eq(domainInvitations.classroom_id, classroomId),
      isNull(domainInvitations.used_at),
      isNull(domainInvitations.revoked_at),
      inArray(domainInvitations.email, inviteEmails),
      sql`${domainInvitations.expires_at} > ${new Date().toISOString()}`,
    ))
    : [];
  const seen = new Set<string>(), result: ClassroomImportRow[] = [];
  for (const entry of entries) {
    const byEmail = entry.email
      ? accounts.find((a) => a.email.toLowerCase() === entry.email)
      : undefined;
    const byName = entry.username
      ? accounts.find((a) => a.username === entry.username && !a.deleted_at)
      : undefined;
    const account = byEmail ?? byName;
    let error = entry.error;
    if (
      !error && entry.username && entry.email && (byName || byEmail) &&
      (!byName || byEmail && byEmail.id !== byName.id ||
        byName.email.toLowerCase() !== entry.email)
    ) error = "用户名与邮箱未匹配到同一账号";
    if (!error && account?.deleted_at) error = "匹配账号已注销";
    if (!error && account) {
      try {
        await assertInstanceAccountNotBanned(account.id, executor);
      } catch (e) {
        if (e instanceof AppError && e.code === "USER_BANNED") {
          error = "匹配账号当前不可加入";
        } else throw e;
      }
    }
    const email = entry.email || account?.email.toLowerCase() || "";
    const identity = account ? `user:${account.id}` : `email:${email}`;
    if (!error && seen.has(identity)) error = "本批次重复账号或邮箱";
    if (!error) seen.add(identity);
    if (!error && account?.class_role && account.class_role !== "student") {
      error = "教学人员身份需要单独调整";
    }
    const pending = invitations.filter((i) => i.email === email).map((i) =>
      i.id
    ).sort();
    let action: ImportAction = "error";
    if (!error) {
      if (
        account?.class_status === "active" && account.domain_status === "active"
      ) action = "already_member";
      else if (account?.domain_status === "active") action = "join";
      else if (!canInviteDomain) error = "请先联系域负责人将此账号加入本域";
      else if (!email) error = "未匹配已有账号，需要提供邮箱邀请";
      else {action = pending.length
          ? replace ? "replace_invite" : "already_invited"
          : "invite";}
    }
    result.push({
      ...entry,
      email,
      action,
      user_id: account?.id ?? null,
      matched_username: account?.username ?? null,
      invitation_ids: pending,
      ...(error ? { error } : {}),
    });
  }
  return result;
}

function summary(rows: ClassroomImportRow[]) {
  return {
    total: rows.length,
    join: rows.filter((r) => r.action === "join").length,
    invite:
      rows.filter((r) => r.action === "invite" || r.action === "replace_invite")
        .length,
    skipped:
      rows.filter((r) =>
        r.action === "already_member" || r.action === "already_invited"
      ).length,
    errors: rows.filter((r) => r.action === "error").length,
  };
}
async function preview(
  executor: Executor,
  access: Awaited<ReturnType<typeof loadClassroom>>,
  entries: ClassroomImportEntry[],
  replace: boolean,
) {
  const rows = await rowsFor(
    executor,
    access.domain.id,
    access.classroom.id,
    entries,
    replace,
    access.platformAdmin ||
      access.context.domainPermissions.has("domain:invitations"),
  );
  return {
    revision: access.classroom.revision,
    rows,
    summary: summary(rows),
    preview_hash: await educationRequestHash({
      domain: access.domain.id,
      classroom: access.classroom.id,
      revision: access.classroom.revision,
      replace,
      rows,
    }),
  };
}

/** CSV 预览先验证成员管理能力，即使精确账号匹配也不能被普通学生用来枚举账号。 */
export async function previewClassroomImport(
  slug: string,
  classroomId: string,
  actorId: string,
  csv: string,
  replace = false,
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  assertClassroomCapability(access, "students:manage");
  return await preview(getDb(), access, parseClassroomImport(csv), replace);
}

/** 执行按账号 → 域 → 班级加锁，重新预览事实；邀请令牌只在首次响应出现，不进入幂等记录。 */
export async function executeClassroomImport(
  slug: string,
  classroomId: string,
  actorId: string,
  key: string,
  revision: number | null,
  input: { csv: string; preview_hash: string; replace_pending?: boolean },
) {
  const entries = parseClassroomImport(input.csv),
    replace = input.replace_pending === true;
  if (typeof input.preview_hash !== "string") {
    throw new BadRequestError("需要已确认的预览哈希");
  }
  const tokens: Record<string, string> = {};
  let performed = false;
  const result = await getDb().transaction(async (tx) => {
    const read = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
    });
    assertClassroomCapability(read, "students:manage");
    const candidates = await rowsFor(
      tx,
      read.domain.id,
      classroomId,
      entries,
      replace,
      read.platformAdmin ||
        read.context.domainPermissions.has("domain:invitations"),
    );
    // 先锁账号，再锁域；NO KEY UPDATE 同时允许其他教学写入所需的外键 KEY SHARE。
    const ids = [
      ...new Set([
        actorId,
        ...candidates.flatMap((r) => r.user_id ? [r.user_id] : []),
      ]),
    ].sort();
    await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids))
      .orderBy(users.id).for("no key update");
    await tx.select({ id: domains.id }).from(domains).where(
      eq(domains.id, read.domain.id),
    ).for("update");
    await loadWorkspace(slug, actorId, { executor: tx, write: true });
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "students:manage");
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "classroom.import",
      key,
      { classroomId, revision, input },
      async () => {
        assertClassroomRevision(access.classroom.revision, revision);
        performed = true;
        const current = await preview(tx, access, entries, replace);
        if (
          current.preview_hash !== input.preview_hash
        ) {
          throw new ConflictError(
            "账号或班级事实已变化，请重新预览",
            "IMPORT_PREVIEW_CONFLICT",
          );
        }
        const rows = [];
        for (const row of current.rows) {
          if (row.action === "join") {
            await joinInvitedClassroom(
              tx,
              access.domain.id,
              classroomId,
              row.user_id!,
            );
          }
          let invitation: { id: string; expires_at: string } | undefined;
          if (row.action === "invite" || row.action === "replace_invite") {
            if (row.invitation_ids.length) {
              await tx.update(domainInvitations)
                .set({ revoked_at: new Date().toISOString() })
                .where(inArray(domainInvitations.id, row.invitation_ids));
            }
            const created = await createDomainInvitation(
              slug,
              actorId,
              row.email,
              { classroomId, executor: tx },
            );
            tokens[created.id] = created.token;
            invitation = { id: created.id, expires_at: created.expires_at };
          }
          rows.push({
            ...row,
            ...(invitation
              ? {
                invitation_id: invitation.id,
                expires_at: invitation.expires_at,
              }
              : {}),
          });
        }
        await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
          operation: "classroom.import",
          classroom_id: classroomId,
          ...current.summary,
        });
        return { rows, summary: current.summary };
      },
    );
  });
  return {
    ...result,
    replayed: !performed,
    rows: result.rows.map((row) => ({
      ...row,
      ...(row.invitation_id && tokens[row.invitation_id]
        ? { token: tokens[row.invitation_id] }
        : {}),
    })),
  };
}
