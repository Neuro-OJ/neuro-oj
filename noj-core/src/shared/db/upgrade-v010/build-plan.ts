/**
 * `v0.10.6 → v0.11` 只读规划构造器。
 *
 * 在源库的 `READ ONLY` 事务中读取所有相关表，在内存中完成重编号、拓扑排序、
 * 废弃数据过滤与外键完整性校验，产出可一次性写入目标库的确定性规划。
 */

import {
  deterministicUuid,
  type PgExecutor,
  readAllRows,
} from "./copy-helpers.ts";
import {
  type GatewaySourcePlan,
  planGatewayMigration,
} from "./migrate-gateway.ts";
import {
  assignReceiptSequences,
  compareStringsLex,
  computeTrainingState,
  DEFAULT_DOMAIN_CONFIGURATION,
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_NAME,
  DEFAULT_DOMAIN_PRESET,
  DEFAULT_DOMAIN_SLUG,
  DROPPED_V010_TABLES,
  type LegacyPermissionInput,
  type LegacyProblemNumberInput,
  type LegacyRoleInput,
  type LegacyRolePermissionInput,
  type LegacyUserInput,
  type LegacyUserRoleInput,
  normalizeAuditAction,
  normalizeUtcMillisIso,
  planAccessDecisions,
  planProblemNumbers,
  REMOVED_SYSTEM_SETTING_KEYS,
  resolveAdminUserIds,
  resolveAnswerVersionId,
  resolveModerationActionDomainId,
  resolveNotificationDomainId,
  ROOT_USER_ID,
  selectDefaultDomainOwner,
  SUBMISSION_ATTEMPT_POINTER_COLUMNS,
  topoSortSelfFk,
  transformOrphanJobItem,
} from "./transform.ts";
import {
  type OrphanJobItemEntry,
  type PrivateProblemPolicy,
  type RestrictedContestPolicy,
  type SkippedMomentPostEntry,
  type UpgradeArchivedSummary,
  UpgradeV010Error,
} from "./types.ts";

export interface ProblemCircularRestore {
  id: string;
  latest_version_id: string | null;
  effective_version_mode: string;
  required_version_id: string | null;
}

export interface SubmissionAttemptRestore {
  id: string;
  active_attempt_id: string | null;
  latest_attempt_id: string | null;
  effective_attempt_id: string | null;
  accepted_attempt_id: string | null;
  contest_effective_attempt_id: string | null;
  contest_accepted_attempt_id: string | null;
}

export interface UpgradeExecutionPlan {
  executedAt: string;
  defaultDomainOwnerId: string;
  maxReceiptSequence: number;
  /** 源库 `sse_events.id` 最大值；导入后据此推进 serial 序列。 */
  maxSseEventId: number;
  gateway: GatewaySourcePlan;
  archivedSummary: UpgradeArchivedSummary;
  tables: Record<string, Record<string, unknown>[]>;
  problemRestores: ProblemCircularRestore[];
  submissionRestores: SubmissionAttemptRestore[];
  objectiveSubmissionRestores: SubmissionAttemptRestore[];
}

function buildSkippedCommentsFilter(
  rawComments: readonly Record<string, unknown>[],
  skippedPostIds: ReadonlySet<string>,
): {
  keptComments: Record<string, unknown>[];
  skippedCommentIds: Set<string>;
} {
  const skippedCommentIds = new Set<string>();
  for (const comment of rawComments) {
    if (skippedPostIds.has(String(comment.post_id))) {
      skippedCommentIds.add(String(comment.id));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of rawComments) {
      const id = String(comment.id);
      if (skippedCommentIds.has(id)) continue;
      const parentId = comment.parent_id ? String(comment.parent_id) : null;
      if (parentId && skippedCommentIds.has(parentId)) {
        skippedCommentIds.add(id);
        changed = true;
      }
    }
  }
  const keptComments = rawComments.filter(
    (c) => !skippedCommentIds.has(String(c.id)),
  );
  return { keptComments, skippedCommentIds };
}

function stripColumns(
  row: Record<string, unknown>,
  nullColumns: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  for (const col of nullColumns) {
    copy[col] = null;
  }
  return copy;
}

function extractAttemptRestore(
  row: Record<string, unknown>,
): SubmissionAttemptRestore {
  return {
    id: String(row.id),
    active_attempt_id: row.active_attempt_id
      ? String(row.active_attempt_id)
      : null,
    latest_attempt_id: row.latest_attempt_id
      ? String(row.latest_attempt_id)
      : null,
    effective_attempt_id: row.effective_attempt_id
      ? String(row.effective_attempt_id)
      : null,
    accepted_attempt_id: row.accepted_attempt_id
      ? String(row.accepted_attempt_id)
      : null,
    contest_effective_attempt_id: row.contest_effective_attempt_id
      ? String(row.contest_effective_attempt_id)
      : null,
    contest_accepted_attempt_id: row.contest_accepted_attempt_id
      ? String(row.contest_accepted_attempt_id)
      : null,
  };
}

function resolveBindingId(
  bindingByProblemId: ReadonlyMap<string, string>,
  problemId: unknown,
  contextLabel: string,
): string {
  const key = String(problemId ?? "");
  const bindingId = bindingByProblemId.get(key);
  if (!bindingId) {
    throw new UpgradeV010Error(
      "DATA_INTEGRITY_ERROR",
      `${contextLabel} 引用了不存在的题目 ID: ${key}`,
      { contextLabel, problemId: key },
    );
  }
  return bindingId;
}

async function collectDroppedTableCounts(
  sourceTx: PgExecutor,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of DROPPED_V010_TABLES) {
    const exists = await sourceTx<{ exists: boolean }[]>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
    `;
    if (!exists[0]?.exists) {
      result[table] = 0;
      continue;
    }
    const rows = await sourceTx.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM "${table}"`,
    );
    result[table] = Number(rows[0]?.count ?? "0");
  }
  return result;
}

export interface BuildUpgradePlanOptions {
  privateProblemPolicy?: PrivateProblemPolicy;
  restrictedContestPolicy?: RestrictedContestPolicy;
}

/** 在只读源库事务中读入并转换全部升级数据。 */
export async function buildUpgradePlan(
  sourceTx: PgExecutor,
  targetPublicTables: ReadonlySet<string>,
  executedAt: string,
  options: BuildUpgradePlanOptions = {},
): Promise<UpgradeExecutionPlan> {
  const [
    rawUsers,
    rawRoles,
    rawPermissions,
    rawRolePermissions,
    rawUserRoles,
    rawProblems,
    rawProblemVersions,
    rawProblemDrafts,
    rawTags,
    rawProblemTags,
    rawStorageObjects,
    rawProblemDraftObjects,
    rawProblemVersionObjects,
    rawContests,
    rawContestProblems,
    rawContestParticipants,
    rawContestClarifications,
    rawContestRankingSnapshots,
    rawTrainings,
    rawTrainingProblems,
    rawSubmissions,
    rawObjectiveSubmissions,
    rawEvaluationAttempts,
    rawSubmissionJobs,
    rawSubmissionJobItems,
    rawSubmissionVersionResults,
    rawSelfTests,
  ] = await Promise.all([
    readAllRows(sourceTx, "users", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "roles"),
    readAllRows(sourceTx, "permissions"),
    readAllRows(sourceTx, "role_permissions"),
    readAllRows(sourceTx, "user_roles"),
    readAllRows(sourceTx, "problems", "ORDER BY created_at ASC, id ASC"),
    readAllRows(
      sourceTx,
      "problem_versions",
      "ORDER BY published_at ASC, id ASC",
    ),
    readAllRows(sourceTx, "problem_drafts"),
    readAllRows(sourceTx, "tags"),
    readAllRows(sourceTx, "problem_tags"),
    readAllRows(sourceTx, "storage_objects"),
    readAllRows(sourceTx, "problem_draft_objects"),
    readAllRows(sourceTx, "problem_version_objects"),
    readAllRows(sourceTx, "contests", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "contest_problems"),
    readAllRows(sourceTx, "contest_participants"),
    readAllRows(
      sourceTx,
      "contest_clarifications",
      "ORDER BY created_at ASC, id ASC",
    ),
    readAllRows(sourceTx, "contest_ranking_snapshots"),
    readAllRows(sourceTx, "trainings", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "training_problems"),
    readAllRows(sourceTx, "submissions", "ORDER BY created_at ASC, id ASC"),
    readAllRows(
      sourceTx,
      "objective_submissions",
      "ORDER BY created_at ASC, id ASC",
    ),
    readAllRows(
      sourceTx,
      "evaluation_attempts",
      "ORDER BY created_at ASC, id ASC",
    ),
    readAllRows(sourceTx, "submission_jobs", "ORDER BY created_at ASC, id ASC"),
    readAllRows(
      sourceTx,
      "submission_job_items",
      "ORDER BY job_id ASC, ordinal ASC",
    ),
    readAllRows(sourceTx, "submission_version_results"),
    readAllRows(sourceTx, "self_tests", "ORDER BY created_at ASC, id ASC"),
  ]);

  const [
    rawBoards,
    rawPosts,
    rawComments,
    rawModerationActions,
    rawReports,
    rawSanctions,
    rawNotifications,
    rawAnnouncements,
    rawUserBans,
    rawIpBans,
    rawOauthAccounts,
    rawTfaCodes,
    rawResetTokens,
    rawCheckIns,
    rawUserConsents,
    rawDataRequests,
    rawLegalDocs,
    rawLegalDocVersions,
    rawEmailEvents,
    rawEmailSuppressions,
    rawJudgeImages,
    rawLlmAliases,
    rawLlmRevocations,
    rawSystemSettings,
    rawAuditLogs,
    rawSearchEntries,
    rawQueryRevisions,
    rawSseEvents,
    rawStorageReservations,
    droppedLegacyTables,
  ] = await Promise.all([
    readAllRows(sourceTx, "community_boards"),
    readAllRows(sourceTx, "community_posts", "ORDER BY created_at ASC, id ASC"),
    readAllRows(
      sourceTx,
      "community_comments",
      "ORDER BY created_at ASC, id ASC",
    ),
    readAllRows(sourceTx, "community_moderation_actions"),
    readAllRows(sourceTx, "community_reports"),
    readAllRows(sourceTx, "community_sanctions"),
    readAllRows(
      sourceTx,
      "community_notifications",
      "ORDER BY created_at ASC, id ASC",
    ),
    readAllRows(sourceTx, "announcements"),
    readAllRows(sourceTx, "user_bans"),
    readAllRows(sourceTx, "ip_bans"),
    readAllRows(sourceTx, "oauth_accounts"),
    readAllRows(sourceTx, "tfa_recovery_codes"),
    readAllRows(sourceTx, "password_reset_tokens"),
    readAllRows(sourceTx, "check_ins"),
    readAllRows(sourceTx, "user_consents"),
    readAllRows(sourceTx, "data_requests"),
    readAllRows(sourceTx, "legal_documents"),
    readAllRows(sourceTx, "legal_document_versions"),
    readAllRows(sourceTx, "email_delivery_events"),
    readAllRows(sourceTx, "email_suppressions"),
    readAllRows(sourceTx, "judge_images"),
    readAllRows(sourceTx, "llm_model_aliases"),
    readAllRows(sourceTx, "llm_token_revocations"),
    readAllRows(sourceTx, "system_settings"),
    readAllRows(sourceTx, "audit_logs", "ORDER BY created_at ASC, id ASC"),
    readAllRows(sourceTx, "search_entries"),
    readAllRows(sourceTx, "query_projection_revisions"),
    readAllRows(sourceTx, "sse_events"),
    readAllRows(sourceTx, "storage_object_reservations"),
    collectDroppedTableCounts(sourceTx),
  ]);

  const typedUsers: LegacyUserInput[] = rawUsers.map((u) => ({
    id: String(u.id),
    deleted_at: u.deleted_at ? String(u.deleted_at) : null,
  }));
  const adminUserIds = resolveAdminUserIds(
    typedUsers,
    rawRoles.map((r) => ({
      id: String(r.id),
      parent_id: r.parent_id ? String(r.parent_id) : null,
    })) satisfies LegacyRoleInput[],
    rawRolePermissions.map((rp) => ({
      role_id: String(rp.role_id),
      permission_id: String(rp.permission_id),
    })) satisfies LegacyRolePermissionInput[],
    rawPermissions.map((p) => ({
      id: String(p.id),
      resource: String(p.resource),
      action: String(p.action),
    })) satisfies LegacyPermissionInput[],
    rawUserRoles.map((ur) => ({
      user_id: String(ur.user_id),
      role_id: String(ur.role_id),
    })) satisfies LegacyUserRoleInput[],
  );
  const ownerId = selectDefaultDomainOwner(typedUsers, adminUserIds);
  const allUserIds = new Set(typedUsers.map((u) => u.id));

  const usersRows = rawUsers.map((u) => ({
    ...u,
    role: adminUserIds.has(String(u.id)) ? "admin" : "user",
  }));

  const membershipsRows: Record<string, unknown>[] = [];
  for (const u of rawUsers) {
    const uid = String(u.id);
    if (u.deleted_at !== null && u.deleted_at !== undefined) continue;
    if (uid === ROOT_USER_ID && ownerId !== ROOT_USER_ID) continue;
    membershipsRows.push({
      id: await deterministicUuid("domain_membership", DEFAULT_DOMAIN_ID, uid),
      domain_id: DEFAULT_DOMAIN_ID,
      user_id: uid,
      status: "active",
      role: uid === ownerId ? "admin" : "member",
      joined_at: String(u.created_at ?? executedAt),
      left_at: null,
    });
  }

  const numberPlan = planProblemNumbers(
    rawProblems.map((p) => ({
      id: String(p.id),
      type: String(p.type),
      number: Number(p.number),
      title: String(p.title),
      created_at: String(p.created_at),
    })) satisfies LegacyProblemNumberInput[],
  );

  // 访问边界：私有题与受限比赛在 v0.11 main 域没有等价语义，必须由运维显式处置
  const accessPlan = planAccessDecisions(
    rawProblems.map((p) => ({
      id: String(p.id),
      title: String(p.title),
      owner_id: String(p.owner_id),
      visibility: String(p.visibility),
      latest_version_id: p.latest_version_id
        ? String(p.latest_version_id)
        : null,
    })),
    rawContests.map((c) => ({
      id: String(c.id),
      title: String(c.title),
      is_public: c.is_public !== false,
      kind: String(c.kind ?? "public"),
      password: c.password ? String(c.password) : null,
    })),
    options,
  );

  const bindingByProblemId = new Map<string, string>();
  const problemRestores: ProblemCircularRestore[] = [];
  const problemsRows: Record<string, unknown>[] = [];
  const domainProblemBindingsRows: Record<string, unknown>[] = [];
  const problemBindingHistoryRows: Record<string, unknown>[] = [];

  for (const p of rawProblems) {
    const problemId = String(p.id);
    const bindingId = await deterministicUuid(
      "domain_problem_binding",
      DEFAULT_DOMAIN_ID,
      problemId,
    );
    bindingByProblemId.set(problemId, bindingId);
    const createdBy = allUserIds.has(String(p.owner_id))
      ? String(p.owner_id)
      : ownerId;
    const disabledAt = accessPlan.disabledProblemIds.has(problemId)
      ? executedAt
      : null;
    const requiredVersionId = p.required_version_id
      ? String(p.required_version_id)
      : null;
    const latestVersionId = p.latest_version_id
      ? String(p.latest_version_id)
      : null;

    problemRestores.push({
      id: problemId,
      latest_version_id: p.latest_version_id
        ? String(p.latest_version_id)
        : null,
      effective_version_mode: String(p.effective_version_mode ?? "any"),
      required_version_id: p.required_version_id
        ? String(p.required_version_id)
        : null,
    });

    problemsRows.push({
      ...p,
      domain_id: DEFAULT_DOMAIN_ID,
      number: numberPlan.numberById.get(problemId)!,
      latest_version_id: null,
      effective_version_mode: "any",
      required_version_id: null,
    });

    domainProblemBindingsRows.push({
      id: bindingId,
      domain_id: DEFAULT_DOMAIN_ID,
      problem_id: problemId,
      visibility: p.visibility === "public" ? "public" : "members",
      revision: 0,
      disabled_at: disabledAt,
      created_by: createdBy,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });

    problemBindingHistoryRows.push({
      id: await deterministicUuid("problem_binding_history", bindingId, "0"),
      binding_id: bindingId,
      problem_id: problemId,
      revision: 0,
      effective_version_mode: String(p.effective_version_mode ?? "any"),
      required_version_id: requiredVersionId,
      // 与 0116 工作区回填一致：exact 策略记录锁定版本而非最新版本
      answer_version_id: resolveAnswerVersionId(
        requiredVersionId,
        latestVersionId,
      ),
      disabled_at: disabledAt,
      actor_id: createdBy,
      reason: "v0.10_upgrade",
      created_at: String(p.updated_at ?? p.created_at),
    });
  }

  const domainsRows = [{
    id: DEFAULT_DOMAIN_ID,
    slug: DEFAULT_DOMAIN_SLUG,
    name: DEFAULT_DOMAIN_NAME,
    description: "",
    status: "active",
    owner_id: ownerId,
    preset: DEFAULT_DOMAIN_PRESET,
    configuration: DEFAULT_DOMAIN_CONFIGURATION,
    revision: 0,
    next_problem_number: numberPlan.nextProblemNumber,
    created_at: executedAt,
    updated_at: executedAt,
  }];

  const domainLimitsRows = [{
    domain_id: DEFAULT_DOMAIN_ID,
    members: null,
    problems: null,
    storage_bytes: null,
    submissions_per_minute: null,
  }];

  const contestsRows = rawContests.map((c) => ({
    ...c,
    // 运维已显式批准的受限比赛按 v0.11 契约归一为公开（不再保留旧口令）
    ...(accessPlan.exposedContestIds.has(String(c.id))
      ? { is_public: true, kind: "public", password: null }
      : {}),
    domain_id: DEFAULT_DOMAIN_ID,
    revision: 0,
    secrecy_enabled: true,
    start_time: normalizeUtcMillisIso(
      String(c.start_time),
      `contests(${c.id}).start_time`,
    ),
    end_time: normalizeUtcMillisIso(
      String(c.end_time),
      `contests(${c.id}).end_time`,
    ),
    freeze_start_time: c.freeze_start_time
      ? normalizeUtcMillisIso(
        String(c.freeze_start_time),
        `contests(${c.id}).freeze_start_time`,
      )
      : null,
  }));

  const contestProblemsRows = rawContestProblems.map((cp) => ({
    ...cp,
    domain_id: DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: resolveBindingId(
      bindingByProblemId,
      cp.problem_id,
      `contest_problems(${cp.contest_id},${cp.problem_id})`,
    ),
  }));

  const clarificationsOrdered = topoSortSelfFk(
    rawContestClarifications,
    (r) => String(r.id),
    (r) => r.reply_to_id ? String(r.reply_to_id) : null,
    "contest_clarifications",
  );

  const trainingsRows = rawTrainings.map((t) => ({
    ...t,
    domain_id: DEFAULT_DOMAIN_ID,
    revision: 0,
    state: computeTrainingState(String(t.visibility)),
  }));

  const receiptSeq = assignReceiptSequences(
    rawSubmissions.map((s) => ({
      id: String(s.id),
      created_at: String(s.created_at),
    })),
    rawObjectiveSubmissions.map((o) => ({
      id: String(o.id),
      created_at: String(o.created_at),
    })),
  );

  const orderedSubmissions = topoSortSelfFk(
    rawSubmissions,
    (r) => String(r.id),
    (r) => r.upgraded_from_id ? String(r.upgraded_from_id) : null,
    "submissions",
  );
  const submissionRestores: SubmissionAttemptRestore[] = [];
  const submissionsRows = orderedSubmissions.map((s) => {
    submissionRestores.push(extractAttemptRestore(s));
    return {
      ...stripColumns(s, SUBMISSION_ATTEMPT_POINTER_COLUMNS),
      receipt_sequence: receiptSeq.submissionSeqById.get(String(s.id))!,
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: resolveBindingId(
        bindingByProblemId,
        s.problem_id,
        `submissions(${s.id})`,
      ),
      assignment_id: null,
      assignment_item_id: null,
    };
  });

  const orderedObjectiveSubmissions = topoSortSelfFk(
    rawObjectiveSubmissions,
    (r) => String(r.id),
    (r) => r.upgraded_from_id ? String(r.upgraded_from_id) : null,
    "objective_submissions",
  );
  const objectiveSubmissionRestores: SubmissionAttemptRestore[] = [];
  const objectiveSubmissionsRows = orderedObjectiveSubmissions.map((o) => {
    objectiveSubmissionRestores.push(extractAttemptRestore(o));
    return {
      ...stripColumns(o, SUBMISSION_ATTEMPT_POINTER_COLUMNS),
      receipt_sequence: receiptSeq.objectiveSeqById.get(String(o.id))!,
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: resolveBindingId(
        bindingByProblemId,
        o.paper_id,
        `objective_submissions(${o.id})`,
      ),
      assignment_id: null,
      assignment_item_id: null,
    };
  });

  const submissionJobsRows = rawSubmissionJobs.map((j) => ({
    ...j,
    domain_id: DEFAULT_DOMAIN_ID,
  }));

  // 批量任务条目的 problem_id 故意不建外键，可能指向已删除题目
  const orphanJobItems: OrphanJobItemEntry[] = [];
  const submissionJobItemsRows = rawSubmissionJobItems.map((item) => {
    const bindingId = bindingByProblemId.get(String(item.problem_id ?? ""));
    if (bindingId) {
      return {
        ...item,
        domain_id: DEFAULT_DOMAIN_ID,
        domain_problem_binding_id: bindingId,
      };
    }
    const orphan = transformOrphanJobItem(
      {
        id: String(item.id),
        job_id: String(item.job_id),
        problem_id: String(item.problem_id ?? ""),
        status: String(item.status),
      },
      executedAt,
      item.finished_at ? String(item.finished_at) : null,
    );
    orphanJobItems.push(orphan.entry);
    return {
      ...item,
      ...(orphan.overrides ?? {}),
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: null,
    };
  });

  const selfTestsRows = rawSelfTests.map((st) => ({
    ...st,
    domain_id: DEFAULT_DOMAIN_ID,
    domain_problem_binding_id: resolveBindingId(
      bindingByProblemId,
      st.problem_id,
      `self_tests(${st.id})`,
    ),
    assignment_id: null,
    assignment_item_id: null,
  }));

  const communityBoardsRows = rawBoards.map((b) => ({
    ...b,
    domain_id: DEFAULT_DOMAIN_ID,
    revision: 0,
  }));

  const skippedMomentPosts: SkippedMomentPostEntry[] = [];
  const skippedPostIds = new Set<string>();
  const communityPostsRows: Record<string, unknown>[] = [];
  for (const post of rawPosts) {
    const type = String(post.type);
    const id = String(post.id);
    if (type !== "solution" && type !== "discussion") {
      skippedPostIds.add(id);
      skippedMomentPosts.push({
        id,
        authorId: String(post.author_id),
        createdAt: String(post.created_at),
      });
      continue;
    }
    communityPostsRows.push({
      ...post,
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: type === "solution"
        ? resolveBindingId(
          bindingByProblemId,
          post.problem_id,
          `community_posts(${id})`,
        )
        : null,
    });
  }

  const { keptComments, skippedCommentIds } = buildSkippedCommentsFilter(
    rawComments,
    skippedPostIds,
  );
  const communityCommentsRows = topoSortSelfFk(
    keptComments,
    (r) => String(r.id),
    (r) => r.parent_id ? String(r.parent_id) : null,
    "community_comments",
  ).map((c) => ({
    ...c,
    domain_id: DEFAULT_DOMAIN_ID,
  }));

  const communityModerationActionsRows = rawModerationActions.map((a) => ({
    ...a,
    domain_id: resolveModerationActionDomainId(String(a.target_type)),
  }));

  const communitySanctionsRows = rawSanctions.map((s) => ({
    ...s,
    domain_id: DEFAULT_DOMAIN_ID,
  }));

  let skippedMessageReports = 0;
  let skippedMomentReports = 0;
  const communityReportsRows: Record<string, unknown>[] = [];
  for (const r of rawReports) {
    if (String(r.content_type) === "message" || r.message_id !== null) {
      skippedMessageReports += 1;
      continue;
    }
    const postId = r.post_id ? String(r.post_id) : null;
    const commentId = r.comment_id ? String(r.comment_id) : null;
    if (
      (postId && skippedPostIds.has(postId)) ||
      (commentId && skippedCommentIds.has(commentId))
    ) {
      skippedMomentReports += 1;
      continue;
    }
    communityReportsRows.push({
      ...r,
      domain_id: DEFAULT_DOMAIN_ID,
    });
  }

  const notificationsRows = rawNotifications.map((n) => {
    const postId = n.post_id ? String(n.post_id) : null;
    const commentId = n.comment_id ? String(n.comment_id) : null;
    return {
      id: n.id,
      domain_id: resolveNotificationDomainId(String(n.type)),
      recipient_id: n.recipient_id,
      actor_id: n.actor_id ?? null,
      type: n.type,
      assignment_id: null,
      event_id: null,
      feedback_id: null,
      help_id: null,
      reply_id: null,
      post_id: postId && !skippedPostIds.has(postId) ? postId : null,
      comment_id: commentId && !skippedCommentIds.has(commentId)
        ? commentId
        : null,
      data: n.data ?? {},
      read_at: n.read_at ?? null,
      created_at: n.created_at,
    };
  });

  // v0.10 公告均为实例级；与迁移 0118 一致保持 domain_id 为空，实例路由才能看到
  const announcementsRows = rawAnnouncements.map((a) => ({
    ...a,
    domain_id: null,
  }));

  const llmModelAliasesRows = rawLlmAliases.map((a) => ({
    ...a,
    domain_id: DEFAULT_DOMAIN_ID,
    revision: 0,
  }));

  const droppedSystemSettings: string[] = [];
  const systemSettingsRows: Record<string, unknown>[] = [];
  let llmDefaultProviderId = "";
  let llmDefaultProviderUpdatedAt = executedAt;
  let llmDefaultModel = "";
  let llmDefaultModelUpdatedAt = executedAt;

  for (const s of rawSystemSettings) {
    const key = String(s.key);
    if (REMOVED_SYSTEM_SETTING_KEYS.has(key)) {
      droppedSystemSettings.push(key);
      continue;
    }
    if (key === "llm_default_provider_id") {
      llmDefaultProviderId = String(s.value ?? "").trim();
      llmDefaultProviderUpdatedAt = String(s.updated_at ?? executedAt);
    } else if (key === "llm_default_model") {
      llmDefaultModel = String(s.value ?? "").trim();
      llmDefaultModelUpdatedAt = String(s.updated_at ?? executedAt);
    }
    systemSettingsRows.push(s);
  }
  droppedSystemSettings.sort(compareStringsLex);

  const domainLlmSetting = llmDefaultProviderId.length > 0 &&
      llmDefaultModel.length > 0
    ? {
      domain_id: DEFAULT_DOMAIN_ID,
      provider_id: llmDefaultProviderId,
      model: llmDefaultModel,
      revision: 1,
      updated_at: compareStringsLex(
          llmDefaultProviderUpdatedAt,
          llmDefaultModelUpdatedAt,
        ) >= 0
        ? llmDefaultProviderUpdatedAt
        : llmDefaultModelUpdatedAt,
    }
    : null;

  let skippedAuditLogs = 0;
  const auditLogsRows: Record<string, unknown>[] = [];
  for (const log of rawAuditLogs) {
    const action = normalizeAuditAction(String(log.action));
    if (action === null) {
      skippedAuditLogs += 1;
      continue;
    }
    auditLogsRows.push({
      ...log,
      action,
    });
  }

  let skippedMessageSearchEntries = 0;
  let skippedMomentSearchEntries = 0;
  const searchEntriesRows: Record<string, unknown>[] = [];
  for (const entry of rawSearchEntries) {
    const entityType = String(entry.entity_type);
    const entityId = String(entry.entity_id);
    if (entityType === "message") {
      skippedMessageSearchEntries += 1;
      continue;
    }
    if (
      (entityType === "post" && skippedPostIds.has(entityId)) ||
      (entityType === "comment" && skippedCommentIds.has(entityId))
    ) {
      skippedMomentSearchEntries += 1;
      continue;
    }
    searchEntriesRows.push({
      ...entry,
      domain_id: DEFAULT_DOMAIN_ID,
    });
  }

  const queryProjectionRevisionsRows: Record<string, unknown>[] =
    rawQueryRevisions.map((r) => {
      const dataRev = Math.max(0, Number(r.data_revision ?? 0));
      const matRev = Math.min(
        dataRev,
        Math.max(0, Number(r.materialized_revision ?? 0)),
      );
      return {
        ...r,
        data_revision: dataRev,
        materialized_revision: matRev,
      };
    });
  if (
    !queryProjectionRevisionsRows.some((r) => String(r.scope_key) === "global")
  ) {
    queryProjectionRevisionsRows.push({
      scope_key: "global",
      data_revision: 1,
      materialized_revision: 0,
    });
  }

  const gateway = await planGatewayMigration(
    sourceTx,
    targetPublicTables,
    domainLlmSetting,
    llmModelAliasesRows,
    ownerId,
  );

  return {
    executedAt,
    defaultDomainOwnerId: ownerId,
    maxReceiptSequence: receiptSeq.maxSequence,
    maxSseEventId: rawSseEvents.reduce(
      (max, e) => Math.max(max, Number(e.id ?? 0)),
      0,
    ),
    gateway,
    archivedSummary: {
      renumberedProblems: numberPlan.renumbered,
      skippedMomentPosts,
      skippedMomentComments: skippedCommentIds.size,
      skippedMessageReports,
      skippedMomentReports,
      skippedMessageSearchEntries,
      skippedMomentSearchEntries,
      skippedAuditLogs,
      droppedSystemSettings,
      droppedLegacyTables,
      privateProblems: accessPlan.privateProblems,
      restrictedContests: accessPlan.restrictedContests,
      orphanJobItems,
    },
    problemRestores,
    submissionRestores,
    objectiveSubmissionRestores,
    tables: {
      users: usersRows,
      domains: domainsRows,
      domain_limits: domainLimitsRows,
      domain_memberships: membershipsRows,
      system_settings: systemSettingsRows,
      domain_llm_settings: domainLlmSetting ? [domainLlmSetting] : [],
      legal_documents: rawLegalDocs,
      legal_document_versions: rawLegalDocVersions,
      user_bans: rawUserBans,
      ip_bans: rawIpBans,
      oauth_accounts: rawOauthAccounts,
      tfa_recovery_codes: rawTfaCodes,
      password_reset_tokens: rawResetTokens,
      check_ins: rawCheckIns,
      user_consents: rawUserConsents,
      data_requests: rawDataRequests,
      email_delivery_events: rawEmailEvents,
      email_suppressions: rawEmailSuppressions,
      judge_images: rawJudgeImages,
      llm_model_aliases: llmModelAliasesRows,
      llm_token_revocations: rawLlmRevocations,
      storage_objects: rawStorageObjects,
      storage_object_reservations: rawStorageReservations,
      tags: rawTags,
      problems: problemsRows,
      problem_versions: rawProblemVersions,
      domain_problem_bindings: domainProblemBindingsRows,
      problem_binding_history: problemBindingHistoryRows,
      problem_drafts: rawProblemDrafts,
      problem_tags: rawProblemTags,
      problem_draft_objects: rawProblemDraftObjects,
      problem_version_objects: rawProblemVersionObjects,
      contests: contestsRows,
      contest_problems: contestProblemsRows,
      contest_participants: rawContestParticipants,
      contest_clarifications: clarificationsOrdered,
      contest_ranking_snapshots: rawContestRankingSnapshots,
      trainings: trainingsRows,
      training_problems: rawTrainingProblems,
      submissions: submissionsRows,
      objective_submissions: objectiveSubmissionsRows,
      evaluation_attempts: rawEvaluationAttempts,
      submission_jobs: submissionJobsRows,
      submission_job_items: submissionJobItemsRows,
      submission_version_results: rawSubmissionVersionResults,
      self_tests: selfTestsRows,
      community_boards: communityBoardsRows,
      community_posts: communityPostsRows,
      community_comments: communityCommentsRows,
      community_moderation_actions: communityModerationActionsRows,
      community_sanctions: communitySanctionsRows,
      community_reports: communityReportsRows,
      notifications: notificationsRows,
      announcements: announcementsRows,
      audit_logs: auditLogsRows,
      search_entries: searchEntriesRows,
      query_projection_revisions: queryProjectionRevisionsRows,
      sse_events: rawSseEvents,
    },
  };
}
