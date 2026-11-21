/**
 * `v0.10.6 → v0.11` 纯函数转换规则与契约常量。
 *
 * 本模块无数据库 I/O 与全局可变状态，可在零依赖单元测试中直接覆盖所有边界条件。
 */

import {
    DEFAULT_DOMAIN_ID,
    DEFAULT_DOMAIN_SLUG,
} from "../../workspace/types.ts";
import {
    type OrphanJobItemEntry,
    type PrivateProblemDecisionEntry,
    type PrivateProblemPolicy,
    type RenumberedProblemEntry,
    type RestrictedContestDecisionEntry,
    type RestrictedContestPolicy,
    UpgradeV010Error,
} from "./types.ts";

export { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_SLUG };

/** 平台保留 Root 用户 ID。 */
export const ROOT_USER_ID = "0";
/** 默认工作空间显示名称（与 `domains.ts` 保持一致）。 */
export const DEFAULT_DOMAIN_NAME = "Neuro OJ";
/** 默认工作空间 preset。 */
export const DEFAULT_DOMAIN_PRESET = "community";
/** 默认工作空间配置事实。 */
export const DEFAULT_DOMAIN_CONFIGURATION = {
    access: "public",
    discoverable: true,
    join_policy: "open",
} as const;

/** `v0.10.6` 发布集对应的最后一条 Drizzle 迁移 tag。 */
export const V010_LAST_MIGRATION_TAG = "0115_ui_submission_mode";

/** `v0.10.6` 中存在但 `v0.11` 已移除或并入新表的 18 张表。 */
export const DROPPED_V010_TABLES: readonly string[] = [
    "carousel_slides",
    "community_board_role_grants",
    "community_bookmarks",
    "community_comment_likes",
    "community_follows",
    "community_notifications",
    "community_post_likes",
    "content_review_queue",
    "conversation_preferences",
    "conversation_reads",
    "conversations",
    "message_deletions",
    "message_reactions",
    "messages",
    "permissions",
    "role_permissions",
    "roles",
    "user_roles",
];

/** `0127` / `0130` / `0131` 下线的系统设置键。 */
export const REMOVED_SYSTEM_SETTING_KEYS: ReadonlySet<string> = new Set([
    "tsa_provider",
    "tsa_url",
    "tsa_root_cert",
    "private_messaging_enabled",
    "content_review_enabled",
    "content_review_provider",
    "content_review_provider_key",
    "content_review_provider_secret",
    "content_review_risk_threshold",
    "content_review_review_threshold",
    "content_review_async_enabled",
    "content_review_timeout_ms",
    "community_reactions_enabled",
    "community_bookmarks_enabled",
    "community_follows_enabled",
]);

/** `v0.11`（`0144`）`audit_logs_action_check` 允许的全部动作。 */
export const ALLOWED_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
    "users.role_change",
    "users.create",
    "users.import",
    "users.reset_password",
    "users.unlock_login",
    "users.ban",
    "users.unban",
    "users.delete",
    "problems.delete",
    "problems.runtime_config_changed",
    "problems.imported",
    "problems.review",
    "problems.version_published",
    "problems.effective_version_policy_changed",
    "contest.problem_version_changed",
    "contest.problem_effective_version_policy_changed",
    "trainings.update",
    "trainings.delete",
    "tags.create",
    "tags.update",
    "tags.delete",
    "tags.merge",
    "submissions.rejudge",
    "submissions.queue_removed",
    "submissions.delete",
    "settings.update",
    "ip_ban.create",
    "ip_ban.delete",
    "auth.login_success",
    "auth.login_failure",
    "auth.register",
    "auth.email_verified",
    "auth.delete_account",
    "auth.change_password",
    "auth.forgot_password_request",
    "auth.password_reset",
    "auth.tfa_setup",
    "auth.tfa_enabled",
    "auth.tfa_disabled",
    "auth.tfa_recovery_regenerated",
    "auth.tfa_recovery_used",
    "community.post_moderated",
    "community.report_resolved",
    "community.sanction_created",
    "community.sanction_revoked",
    "community.preset_applied",
    "community.board_create",
    "community.board_update",
    "community.post_flag",
    "announcement.create",
    "announcement.update",
    "announcement.delete",
    "carousel.create",
    "carousel.update",
    "carousel.delete",
    "carousel.reorder",
    "review.queued",
    "review.rejected",
    "review.resolved",
    "contest.ranking_snapshot",
    "contest.create",
    "contest.update",
    "contest.delete",
    "contest.participants_add",
    "contest.participants_remove",
    "contest.kind_change",
    "contest.reset_code",
    "judge_images.create",
    "judge_images.update",
    "judge_images.delete",
    "email_delivery.clear_suppression",
    "llm_provider.create",
    "llm_provider.update",
    "llm_quota.upsert",
    "llm_model_alias.upsert",
    "llm_model_alias.delete",
    "legal.publish_version",
    "legal.data_request_update",
    "background_task.retry",
    "knowledge.mapping.update",
    "knowledge.difficulty.pass_ratio",
    "domain.create",
    "domain.update",
    "domain.status",
    "domain.join",
    "domain.join_review",
    "domain.member_role",
    "domain.member_remove",
    "domain.transfer",
    "domain.invite_create",
    "domain.invite_accept",
    "domain.invite_revoke",
    "domain.llm_read",
    "domain.llm_settings",
    "domain.llm_provider",
    "domain.llm_quota",
]);

/** `submissions` / `objective_submissions` 与 `evaluation_attempts` 的回填列。 */
export const SUBMISSION_ATTEMPT_POINTER_COLUMNS = [
    "active_attempt_id",
    "latest_attempt_id",
    "effective_attempt_id",
    "accepted_attempt_id",
    "contest_effective_attempt_id",
    "contest_accepted_attempt_id",
] as const;

/** 与语言区域无关的 ASCII/Unicode 码点字符串比较。 */
export function compareStringsLex(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export interface LegacyProblemNumberInput {
    id: string;
    type: string;
    number: number;
    title: string;
    created_at: string;
}

export interface ProblemNumberPlan {
    numberById: Map<string, number>;
    renumbered: RenumberedProblemEntry[];
    nextProblemNumber: number;
}

/**
 * 规划 `problems` 在迁移到 `main` 工作空间后的唯一题号。
 *
 * - `P` 题保留原题号（冲突时直接报错）；
 * - `U` 题按 `(number ASC, created_at ASC, id ASC)` 顺序重编号为不与已有题号
 *   冲突的连续整数，起点为 `max(1000, maxPNumber) + 1`；
 * - 返回 `domains.next_problem_number = max(1001, maxAssignedNumber + 1)`。
 */
export function planProblemNumbers(
    problems: readonly LegacyProblemNumberInput[],
): ProblemNumberPlan {
    const numberById = new Map<string, number>();
    const usedNumbers = new Set<number>();
    const userProblems: LegacyProblemNumberInput[] = [];
    let maxPNumber = 0;

    for (const problem of problems) {
        if (
            typeof problem.number !== "number" ||
            !Number.isSafeInteger(problem.number)
        ) {
            throw new UpgradeV010Error(
                "DATA_INTEGRITY_ERROR",
                `题目 ${problem.id} 存在非法题号`,
                { problemId: problem.id },
            );
        }
        if (problem.type === "P") {
            if (usedNumbers.has(problem.number)) {
                throw new UpgradeV010Error(
                    "DATA_INTEGRITY_ERROR",
                    `存在重复的 P 题号 ${problem.number}`,
                    { problemId: problem.id, number: problem.number },
                );
            }
            usedNumbers.add(problem.number);
            numberById.set(problem.id, problem.number);
            if (problem.number > maxPNumber) maxPNumber = problem.number;
            continue;
        }
        if (problem.type === "U") {
            userProblems.push(problem);
            continue;
        }
        throw new UpgradeV010Error(
            "DATA_INTEGRITY_ERROR",
            `题目 ${problem.id} 的 type=${problem.type} 不受支持`,
            { problemId: problem.id, type: problem.type },
        );
    }

    userProblems.sort((a, b) =>
        a.number - b.number ||
        compareStringsLex(a.created_at, b.created_at) ||
        compareStringsLex(a.id, b.id)
    );

    const renumbered: RenumberedProblemEntry[] = [];
    let candidate = Math.max(1000, maxPNumber) + 1;
    for (const problem of userProblems) {
        while (usedNumbers.has(candidate)) {
            candidate += 1;
        }
        usedNumbers.add(candidate);
        numberById.set(problem.id, candidate);
        renumbered.push({
            id: problem.id,
            oldType: "U",
            oldNumber: problem.number,
            newNumber: candidate,
            title: problem.title,
        });
        candidate += 1;
    }

    let maxAssignedNumber = 0;
    for (const num of usedNumbers) {
        if (num > maxAssignedNumber) maxAssignedNumber = num;
    }
    const nextProblemNumber = Math.max(1001, maxAssignedNumber + 1);

    return { numberById, renumbered, nextProblemNumber };
}

export interface LegacyUserInput {
    id: string;
    deleted_at: string | null;
}

export interface LegacyRoleInput {
    id: string;
    parent_id: string | null;
}

export interface LegacyPermissionInput {
    id: string;
    resource: string;
    action: string;
}

export interface LegacyRolePermissionInput {
    role_id: string;
    permission_id: string;
}

export interface LegacyUserRoleInput {
    user_id: string;
    role_id: string;
}

/**
 * 从 `v0.10.6` RBAC 四表解析平台级 `admin` 用户集合。
 *
 * - `roles.parent_id` 允许父子继承（子角色继承父角色权限），内置环检测；
 * - 持有 `admin:full_access` 权限链角色的未删除用户，以及 `id = '0'` 平台用户，
 *   映射为 `users.role = 'admin'`，其余用户映射为 `'user'`。
 */
export function resolveAdminUserIds(
    users: readonly LegacyUserInput[],
    roles: readonly LegacyRoleInput[],
    rolePermissions: readonly LegacyRolePermissionInput[],
    permissions: readonly LegacyPermissionInput[],
    userRoles: readonly LegacyUserRoleInput[],
): Set<string> {
    const fullAccessPermIds = new Set(
        permissions
            .filter((p) => p.resource === "admin" && p.action === "full_access")
            .map((p) => p.id),
    );

    const directAdminRoleIds = new Set(
        rolePermissions
            .filter((rp) => fullAccessPermIds.has(rp.permission_id))
            .map((rp) => rp.role_id),
    );

    const parentByRoleId = new Map<string, string | null>();
    for (const role of roles) {
        parentByRoleId.set(role.id, role.parent_id ?? null);
    }

    const adminRoleCache = new Map<string, boolean>();
    const isAdminRole = (roleId: string): boolean => {
        const cached = adminRoleCache.get(roleId);
        if (cached !== undefined) return cached;
        const visiting = new Set<string>();
        const chain: string[] = [];
        let current: string | null = roleId;
        let granted = false;
        while (current !== null) {
            const cacheHit = adminRoleCache.get(current);
            if (cacheHit !== undefined) {
                granted = cacheHit;
                break;
            }
            if (directAdminRoleIds.has(current)) {
                granted = true;
                break;
            }
            if (visiting.has(current)) {
                break;
            }
            visiting.add(current);
            chain.push(current);
            current = parentByRoleId.get(current) ?? null;
        }
        if (!granted) {
            for (const id of chain) adminRoleCache.set(id, false);
            return false;
        }
        for (const id of chain) adminRoleCache.set(id, true);
        return true;
    };

    const usersWithAdminRole = new Set<string>();
    for (const ur of userRoles) {
        if (isAdminRole(ur.role_id)) {
            usersWithAdminRole.add(ur.user_id);
        }
    }

    const result = new Set<string>();
    for (const user of users) {
        if (user.id === ROOT_USER_ID) {
            result.add(user.id);
            continue;
        }
        if (user.deleted_at === null && usersWithAdminRole.has(user.id)) {
            result.add(user.id);
        }
    }
    return result;
}

/**
 * 选择默认工作空间（`main`）的 `owner_id`（与 `domains.ts` 口径一致）。
 *
 * 优先选择未删除且拥有平台 `admin` 身份的非 Root 用户中 ID 最小者；
 * 若无此类管理员，回退到存在且未删除（或存在）的 Root 用户 `'0'`。
 */
export function selectDefaultDomainOwner(
    users: readonly LegacyUserInput[],
    adminUserIds: ReadonlySet<string>,
): string {
    const activeAdmins = users
        .filter((u) =>
            u.id !== ROOT_USER_ID && u.deleted_at === null &&
            adminUserIds.has(u.id)
        )
        .map((u) => u.id)
        .sort(compareStringsLex);

    if (activeAdmins.length > 0) {
        return activeAdmins[0]!;
    }

    const rootUser = users.find((u) => u.id === ROOT_USER_ID);
    if (rootUser) {
        return rootUser.id;
    }

    throw new UpgradeV010Error(
        "DATA_INTEGRITY_ERROR",
        "源库既没有活跃的非 Root 管理员，也没有 Root 用户 '0'，无法确定默认工作空间所有者",
    );
}

/**
 * 按自引用外键（父节点先于子节点）拓扑排序，并在存在环或悬空父引用时抛错。
 */
export function topoSortSelfFk<T>(
    rows: readonly T[],
    getId: (row: T) => string,
    getParentId: (row: T) => string | null | undefined,
    tableName: string,
): T[] {
    const indexById = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 1) {
        const id = getId(rows[i]!);
        if (indexById.has(id)) {
            throw new UpgradeV010Error(
                "DATA_INTEGRITY_ERROR",
                `表 ${tableName} 存在重复主键 ${id}`,
                { table: tableName, id },
            );
        }
        indexById.set(id, i);
    }

    const childrenByParent = new Map<string, number[]>();
    const ready: number[] = [];

    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const id = getId(row);
        const parentId = getParentId(row);
        if (parentId === null || parentId === undefined) {
            ready.push(i);
            continue;
        }
        if (parentId === id) {
            throw new UpgradeV010Error(
                "DATA_INTEGRITY_ERROR",
                `表 ${tableName} 存在指向自身的循环外键 (${id})`,
                { table: tableName, id },
            );
        }
        if (!indexById.has(parentId)) {
            throw new UpgradeV010Error(
                "DATA_INTEGRITY_ERROR",
                `表 ${tableName} 行 ${id} 引用了不存在的父记录 ${parentId}`,
                { table: tableName, id, parentId },
            );
        }
        let list = childrenByParent.get(parentId);
        if (!list) {
            list = [];
            childrenByParent.set(parentId, list);
        }
        list.push(i);
    }

    const ordered: T[] = [];
    let cursor = 0;
    while (cursor < ready.length) {
        const idx = ready[cursor]!;
        cursor += 1;
        const row = rows[idx]!;
        ordered.push(row);
        const children = childrenByParent.get(getId(row));
        if (children) {
            for (const childIdx of children) {
                ready.push(childIdx);
            }
        }
    }

    if (ordered.length !== rows.length) {
        throw new UpgradeV010Error(
            "DATA_INTEGRITY_ERROR",
            `表 ${tableName} 存在自引用环（${ordered.length}/${rows.length} 行可排序）`,
            { table: tableName, sorted: ordered.length, total: rows.length },
        );
    }

    return ordered;
}

/** 题单发布状态回填规则（与 `0125_domain_training_publication_state.sql` 一致）。 */
export function computeTrainingState(
    visibility: string,
): "draft" | "published" {
    return visibility === "public" || visibility === "unlisted"
        ? "published"
        : "draft";
}

/** 通知所属域解析（与 `0123` `community_notifications_workspace_check` 一致）。 */
export function resolveNotificationDomainId(
    notificationType: string,
): string | null {
    if (notificationType === "follow" || notificationType === "ban") {
        return null;
    }
    if (
        notificationType === "reply" ||
        notificationType === "like" ||
        notificationType === "moderation" ||
        notificationType === "clarification" ||
        notificationType === "report"
    ) {
        return DEFAULT_DOMAIN_ID;
    }
    throw new UpgradeV010Error(
        "DATA_INTEGRITY_ERROR",
        `通知表存在不受支持的 type=${notificationType}`,
        { type: notificationType },
    );
}

/** 审核动作所属域解析（与 `0116` `community_moderation_actions_workspace_check` 一致）。 */
export function resolveModerationActionDomainId(
    targetType: string,
): string | null {
    if (targetType === "message" || targetType === "user_ban") {
        return null;
    }
    return DEFAULT_DOMAIN_ID;
}

/**
 * 规范化并过滤审计日志 `action`。
 *
 * - `domain.member_roles` → `domain.member_role`；
 * - 已被 `0132` / `0133` 下线的动作返回 `null`，迁移时跳过并记入归档统计。
 */
export function normalizeAuditAction(action: string): string | null {
    const normalized = action === "domain.member_roles"
        ? "domain.member_role"
        : action;
    return ALLOWED_AUDIT_ACTIONS.has(normalized) ? normalized : null;
}

export interface SubmissionSequenceInput {
    id: string;
    created_at: string;
}

export interface ReceiptSequenceAssignment {
    submissionSeqById: Map<string, number>;
    objectiveSeqById: Map<string, number>;
    maxSequence: number;
}

/**
 * 为 `submissions` 与 `objective_submissions` 统一按创建时间递增分配 `receipt_sequence`。
 */
export function assignReceiptSequences(
    submissions: readonly SubmissionSequenceInput[],
    objectiveSubmissions: readonly SubmissionSequenceInput[],
): ReceiptSequenceAssignment {
    const combined: Array<{
        kind: "submission" | "objective";
        id: string;
        created_at: string;
    }> = [
        ...submissions.map((s) => ({
            kind: "submission" as const,
            id: s.id,
            created_at: s.created_at,
        })),
        ...objectiveSubmissions.map((o) => ({
            kind: "objective" as const,
            id: o.id,
            created_at: o.created_at,
        })),
    ];

    combined.sort((a, b) =>
        compareStringsLex(a.created_at, b.created_at) ||
        compareStringsLex(a.id, b.id) ||
        compareStringsLex(a.kind, b.kind)
    );

    const submissionSeqById = new Map<string, number>();
    const objectiveSeqById = new Map<string, number>();
    let seq = 0;
    for (const item of combined) {
        seq += 1;
        if (item.kind === "submission") {
            submissionSeqById.set(item.id, seq);
        } else {
            objectiveSeqById.set(item.id, seq);
        }
    }

    return { submissionSeqById, objectiveSeqById, maxSequence: seq };
}

const UTC_MILLIS_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 规范化竞赛时间戳为 `contests_time_format_check` 要求的 `.sssZ` 格式。 */
export function normalizeUtcMillisIso(
    value: string,
    contextLabel: string,
): string {
    if (UTC_MILLIS_ISO_RE.test(value)) {
        return value;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new UpgradeV010Error(
            "DATA_INTEGRITY_ERROR",
            `${contextLabel} 包含非法时间戳: ${value}`,
            { contextLabel },
        );
    }
    return parsed.toISOString();
}

/**
 * 与 `0116` 工作区回填一致的绑定历史作答版本：`exact` 策略锁定的
 * `required_version_id` 优先，否则取最新发布版本。
 */
export function resolveAnswerVersionId(
    requiredVersionId: string | null,
    latestVersionId: string | null,
): string | null {
    return requiredVersionId ?? latestVersionId;
}

export interface LegacyProblemAccessInput {
    id: string;
    title: string;
    owner_id: string;
    visibility: string;
    latest_version_id: string | null;
}

export interface LegacyContestAccessInput {
    id: string;
    title: string;
    is_public: boolean;
    kind: string;
    password: string | null;
}

export interface AccessDecisionPlan {
    privateProblems: PrivateProblemDecisionEntry[];
    /** 需写入 `disabled_at` 的题目 ID。 */
    disabledProblemIds: Set<string>;
    restrictedContests: RestrictedContestDecisionEntry[];
    /** 需按 v0.11 契约归一为公开（`is_public=true`、`kind='public'`、口令清空）的比赛 ID。 */
    exposedContestIds: Set<string>;
}

/** v0.10.6 中仅所有者/管理员可读、但在 v0.11 `main` 域会被按 ID 公开读取的题目。 */
export function isRestrictedLegacyProblem(
    problem: LegacyProblemAccessInput,
): boolean {
    return problem.visibility !== "public" &&
        problem.latest_version_id !== null;
}

/** v0.10.6 中不公开列出、仅受邀或需口令报名的比赛。 */
export function isRestrictedLegacyContest(
    contest: LegacyContestAccessInput,
): boolean {
    return !contest.is_public || contest.kind === "invite" ||
        (contest.password !== null && contest.password.length > 0);
}

/**
 * 规划访问边界处置；存在受限数据而运维未明确选择处置方式时，
 * 在只读规划阶段（含 `--dry-run`）以 `ACCESS_DECISION_REQUIRED` 阻断。
 */
export function planAccessDecisions(
    problems: readonly LegacyProblemAccessInput[],
    contests: readonly LegacyContestAccessInput[],
    policies: {
        privateProblemPolicy?: PrivateProblemPolicy;
        restrictedContestPolicy?: RestrictedContestPolicy;
    },
): AccessDecisionPlan {
    const restrictedProblems = problems.filter(isRestrictedLegacyProblem);
    const restrictedContests = contests.filter(isRestrictedLegacyContest);

    const missing: string[] = [];
    if (restrictedProblems.length > 0 && !policies.privateProblemPolicy) {
        missing.push(
            `${restrictedProblems.length} 道已发布私有题需指定 --private-problems=disable|expose`,
        );
    }
    if (restrictedContests.length > 0 && !policies.restrictedContestPolicy) {
        missing.push(
            `${restrictedContests.length} 场非公开/邀请/口令比赛需指定 --restricted-contests=expose`,
        );
    }
    if (missing.length > 0) {
        throw new UpgradeV010Error(
            "ACCESS_DECISION_REQUIRED",
            `v0.11 公开 main 域不识别旧版私有题与邀请赛访问限制，直接导入会扩大访问范围：${
                missing.join("；")
            }`,
            {
                privateProblemIds: restrictedProblems.map((p) => p.id),
                restrictedContestIds: restrictedContests.map((c) => c.id),
            },
        );
    }

    const privateProblemPolicy = policies.privateProblemPolicy ?? "disable";
    const restrictedContestPolicy = policies.restrictedContestPolicy ??
        "expose";
    return {
        privateProblems: restrictedProblems.map((p) => ({
            id: p.id,
            title: p.title,
            ownerId: p.owner_id,
            action: privateProblemPolicy,
        })),
        disabledProblemIds: privateProblemPolicy === "disable"
            ? new Set(restrictedProblems.map((p) => p.id))
            : new Set(),
        restrictedContests: restrictedContests.map((c) => ({
            id: c.id,
            title: c.title,
            wasPublic: c.is_public,
            kind: c.kind,
            hadPassword: c.password !== null && c.password.length > 0,
            action: restrictedContestPolicy,
        })),
        exposedContestIds: new Set(restrictedContests.map((c) => c.id)),
    };
}

/** 目标库允许绑定为空的批量任务条目终态（`submission_job_items_binding_required_check`）。 */
const NULL_BINDING_JOB_ITEM_STATUSES: ReadonlySet<string> = new Set([
    "failed",
    "skipped",
]);

/** 引用已删除题目的批量任务条目导入时写入的原因码。 */
export const ORPHAN_JOB_ITEM_REASON_CODE = "UPGRADE_PROBLEM_DELETED";

export interface LegacyJobItemInput {
    id: string;
    job_id: string;
    problem_id: string;
    status: string;
}

export interface OrphanJobItemTransform {
    /** 写入目标库时覆盖的列；`null` 表示原样保留（仅绑定置空）。 */
    overrides: Record<string, unknown> | null;
    entry: OrphanJobItemEntry;
}

/**
 * 题目已删除的批量任务条目转换规则：
 * - `failed` / `skipped`：保留原状态，绑定置空；
 * - 其余状态（`pending` / `preparing` / `dispatched` / `succeeded`）：目标库要求非空绑定，
 *   统一转为 `skipped` 终态并写入 `UPGRADE_PROBLEM_DELETED` 原因码与原状态说明，
 *   清空调度租约；原 `attempt_id` / `result_submission_id` 保留以便追溯。
 */
export function transformOrphanJobItem(
    item: LegacyJobItemInput,
    executedAt: string,
    finishedAt: string | null,
): OrphanJobItemTransform {
    if (NULL_BINDING_JOB_ITEM_STATUSES.has(item.status)) {
        return {
            overrides: null,
            entry: {
                id: item.id,
                jobId: item.job_id,
                problemId: item.problem_id,
                originalStatus: item.status,
                importedStatus: item.status,
            },
        };
    }
    return {
        overrides: {
            status: "skipped",
            reason_code: ORPHAN_JOB_ITEM_REASON_CODE,
            reason_message:
                `v0.10 升级：题目 ${item.problem_id} 已删除，原状态 ${item.status} 转为 skipped`,
            lease_owner: null,
            lease_until: null,
            next_dispatch_at: null,
            finished_at: finishedAt ?? executedAt,
        },
        entry: {
            id: item.id,
            jobId: item.job_id,
            problemId: item.problem_id,
            originalStatus: item.status,
            importedStatus: "skipped",
        },
    };
}
