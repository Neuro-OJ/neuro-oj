/**
 * 有效版本策略切换与竞赛固定版本维护（Handbook §1.2、§4.5、§3.5）。
 *
 * 三个**互相独立**的动作在这里体现为三个不同的入口：
 * - 发布新版本（`publishProblemVersion`，不改变策略）；
 * - 重测指定版本（任务服务，不改变策略）；
 * - 切换有效版本策略（本文件）。
 *
 * 关键语义：
 * - 策略切换在**数据库事务提交后立即生效**：同一事务内重算全部受影响提交的投影
 *   并递增 `query_projection_revisions`，不依赖 TTL 或异步视图刷新；
 * - 策略宿主行加更新锁（§5.1），与结果写入互斥，防止旧策略投影覆盖新策略；
 * - `expected_revision` 乐观锁：不匹配返回 409；
 * - 竞赛 `exact(X)` **同时固定作答版本为 X**（§1.2）；
 * - 单独升级竞赛固定版本时，若现有 `exact` 策略与目标固定版本冲突 → 409。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  domains,
  objectiveSubmissions,
  problems,
  submissions,
} from "../../../../shared/db/schema.ts";
import { logAudit } from "../../../system/index.ts";
import {
  assertWorkspacePermission,
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  loadWorkspace,
} from "../../../workspace/index.ts";
import { setDomainProblemBindingPolicy } from "../../../../modules/problems/index.ts";
import {
  type EffectiveVersionPolicy,
  policyToColumns,
} from "../../../../shared/versioning/types.ts";
import { loadPublishedVersionContent } from "./submission-version.ts";
import { recomputeContestProblemProjections } from "./projection.ts";

/** 策略切换结果。 */
export interface PolicyChangeResult {
  policy: EffectiveVersionPolicy;
  /** 策略宿主的新 revision（乐观锁版本，也是投影版本）。 */
  revision: number;
  /** 本次重算覆盖的提交数量（题库口径限定当前绑定，竞赛口径限定该场该题）。 */
  affected_submissions: number;
}

/** 409：策略 revision 过时。 */
export function policyRevisionConflict(
  expected: number,
  actual: number,
): AppError {
  return new AppError(
    `有效版本策略已被修改（预期 revision ${expected}，当前 ${actual}）`,
    409,
    "EFFECTIVE_POLICY_REVISION_CONFLICT",
  );
}

/** 409：竞赛固定版本与现有 exact 策略冲突。 */
export function contestPolicyConflict(
  pinnedVersionId: string,
  requiredVersionId: string,
): AppError {
  return new AppError(
    `竞赛现有 exact 策略（要求版本 ${requiredVersionId}）与目标固定版本 ${pinnedVersionId} 冲突：` +
      "请在同一请求中显式提交新策略",
    409,
    "CONTEST_PROBLEM_VERSION_POLICY_CONFLICT",
  );
}

/** 策略宿主行锁强度：`update` 用于要改写的宿主，`share` 用于只读但需与写入互斥的宿主。 */
export type PolicyHostLockStrength = "update" | "share";

/**
 * 单条 `SELECT ... FOR ...` 最多锁定的宿主行数。
 *
 * 只为限制单语句绑定参数数量；分块按 ID 升序推进、块内也按 ID 升序，
 * 因此整体获取顺序仍是**全局升序**。
 */
export const POLICY_HOST_LOCK_BATCH = 500;

/**
 * 按 Handbook §5.1 固定锁序获取策略宿主锁：
 * **全部题目（按 ID 升序）→ 全部竞赛（按 ID 升序）**。
 *
 * 这是策略宿主锁序的**唯一实现**，所有会修改有效策略或重算投影的入口
 * （批量受理 `acceptRejudgeJob`、逐条 `setProblemEffectiveVersionPolicy` /
 * `setContestProblemEffectiveVersionPolicy` / `upgradeContestProblemPinnedVersion`）
 * 都必须经由它，且必须在**任何策略写入与投影重算之前一次拿全**。
 *
 * 为什么必须"一次拿全"而不是"边重算边取下一把"：策略重算会先写提交行并递增
 * `query_projection_revisions`（含 `global`），此时若继续获取后续竞赛锁，就与
 * 并发请求形成「各自持有对方想要的锁」的环 → PostgreSQL 40P01 死锁。
 * 按同一全序一次拿全部宿主锁后，环不可能出现。
 *
 * 逐条入口与批量入口共用同一全序，避免两个入口互相成环。
 *
 * @param hosts 相关宿主 ID（内部去重并升序排序；空集合不产生任何锁）
 * @param locks 锁强度（默认 `update`：策略宿主要被改写；`share` 用于只读互斥）
 */
export async function lockEffectivePolicyHosts(
  executor: Executor,
  hosts: {
    problemIds?: Iterable<string>;
    contestIds?: Iterable<string>;
  },
  locks: {
    problemLock?: PolicyHostLockStrength;
    contestLock?: PolicyHostLockStrength;
  } = {},
): Promise<void> {
  const problemIds = [...new Set(hosts.problemIds ?? [])].sort();
  const contestIds = [...new Set(hosts.contestIds ?? [])].sort();
  const problemLock = locks.problemLock ?? "update";
  const contestLock = locks.contestLock ?? "update";
  if (contestIds.length) {
    const rows = await executor.select({ domainId: contests.domain_id }).from(
      contests,
    ).where(inArray(contests.id, contestIds));
    const domainIds = [
      ...new Set(rows.map((row) => row.domainId ?? DEFAULT_DOMAIN_ID)),
    ].sort();
    await executor.select({ id: domains.id }).from(domains).where(
      inArray(domains.id, domainIds),
    ).orderBy(domains.id).for("share");
  }
  for (
    let offset = 0;
    offset < problemIds.length;
    offset += POLICY_HOST_LOCK_BATCH
  ) {
    await executor.select({ id: problems.id }).from(problems).where(
      inArray(
        problems.id,
        problemIds.slice(offset, offset + POLICY_HOST_LOCK_BATCH),
      ),
    ).orderBy(problems.id).for(problemLock);
  }
  for (
    let offset = 0;
    offset < contestIds.length;
    offset += POLICY_HOST_LOCK_BATCH
  ) {
    await executor.select({ id: contests.id }).from(contests).where(
      inArray(
        contests.id,
        contestIds.slice(offset, offset + POLICY_HOST_LOCK_BATCH),
      ),
    ).orderBy(contests.id).for(contestLock);
  }
}

/** 校验 `exact` 策略引用的版本属于该题且已发布。 */
async function assertPolicyVersionUsable(
  problemId: string,
  policy: EffectiveVersionPolicy,
  executor: Executor,
): Promise<void> {
  if (policy.mode !== "exact") return;
  const loaded = await loadPublishedVersionContent(
    problemId,
    policy.version_id,
    executor,
  );
  if (!loaded) {
    throw new AppError(
      `要求版本不存在或未发布：${policy.version_id}`,
      404,
      "PROBLEM_VERSION_NOT_FOUND",
    );
  }
}

/**
 * 默认域兼容入口：切换 main 本域题库绑定的有效版本策略（`any` / `exact(X)`）。
 *
 * 不修改最新版指针——默认作答版本由解析器按策略选择（§1.2）。
 */
export async function setProblemEffectiveVersionPolicy(
  problemId: string,
  input: {
    policy: EffectiveVersionPolicy;
    expectedRevision: number;
    actorId?: string | null;
  },
  executor?: Executor,
): Promise<PolicyChangeResult> {
  const write = async (tx: Executor) => {
    const workspace = await loadWorkspace(
      DEFAULT_DOMAIN_SLUG,
      input.actorId ?? "0",
      { executor: tx, write: true },
    );
    assertWorkspacePermission(workspace.context, "problem:policy");
    const [source] = await tx.select({ number: problems.number }).from(problems)
      .where(
        and(
          eq(problems.id, problemId),
          eq(problems.domain_id, DEFAULT_DOMAIN_ID),
        ),
      );
    if (!source) {
      throw new AppError("默认域题目不存在", 404, "PROBLEM_NOT_FOUND");
    }
    const [binding] = await tx.select({ id: domainProblemBindings.id }).from(
      domainProblemBindings,
    ).where(and(
      eq(domainProblemBindings.domain_id, DEFAULT_DOMAIN_ID),
      eq(domainProblemBindings.problem_id, problemId),
      eq(domainProblemBindings.kind, "owned"),
    ));
    if (!binding) {
      throw new AppError("默认域题目不存在", 404, "PROBLEM_NOT_FOUND");
    }
    const updated = await setDomainProblemBindingPolicy(
      DEFAULT_DOMAIN_SLUG,
      String(source.number),
      input.actorId ?? "0",
      input.expectedRevision,
      input.policy,
      "默认域兼容入口修改有效版本策略",
      tx,
    );
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(
      submissions,
    )
      .where(eq(submissions.domain_problem_binding_id, binding.id));
    const [objectiveCount] = await tx.select({
      total: sql<number>`count(*)::int`,
    }).from(objectiveSubmissions)
      .where(eq(objectiveSubmissions.domain_problem_binding_id, binding.id));
    return {
      policy: input.policy,
      revision: updated.revision,
      affected_submissions: count.total + objectiveCount.total,
    };
  };
  return executor ? await write(executor) : await getDb().transaction(write);
}

/**
 * 切换「竞赛 × 题目」有效版本策略。
 *
 * `exact(X)` 同时把该竞赛的固定作答版本设为 X（§1.2：竞赛采用 exact(X) 时，
 * 固定作答版本必须同时为 X）；`any` 只改策略、不动固定版本。
 */
export async function setContestProblemEffectiveVersionPolicy(
  contestId: string,
  problemId: string,
  input: {
    policy: EffectiveVersionPolicy;
    expectedRevision: number;
    actorId?: string | null;
  },
  executor?: Executor,
): Promise<PolicyChangeResult> {
  const db = getDb();
  const write = async (tx: Executor) => {
    // §5.1 固定锁序：题目（share，只读宿主）先于竞赛（update）；与批量受理入口同序。
    await lockEffectivePolicyHosts(tx, {
      problemIds: [problemId],
      contestIds: [contestId],
    }, { problemLock: "share" });
    const [row] = await tx.select({
      pinned: contestProblems.pinned_version_id,
      mode: contestProblems.effective_version_mode,
      required: contestProblems.required_version_id,
      revision: contestProblems.effective_policy_revision,
    }).from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    ).for("update");
    if (!row) {
      throw new AppError(
        "该题目不属于此竞赛",
        404,
        "CONTEST_PROBLEM_NOT_FOUND",
      );
    }
    if (row.revision !== input.expectedRevision) {
      throw policyRevisionConflict(input.expectedRevision, row.revision);
    }
    await assertPolicyVersionUsable(problemId, input.policy, tx);

    const columns = policyToColumns(input.policy);
    const nextRevision = row.revision + 1;
    const pinned = input.policy.mode === "exact"
      ? input.policy.version_id
      : row.pinned;
    await tx.update(contestProblems).set({
      effective_version_mode: columns.effective_version_mode,
      required_version_id: columns.required_version_id,
      pinned_version_id: pinned,
      effective_policy_revision: nextRevision,
    }).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    );

    const affected = await recomputeContestProblemProjections(
      tx,
      contestId,
      problemId,
    );
    return {
      policy: input.policy,
      revision: nextRevision,
      affected_submissions: affected,
      pinned,
      previous: { mode: row.mode, required: row.required },
    };
  };
  const result = executor ? await write(executor) : await db.transaction(write);

  if (!executor) {
    try {
      await logAudit(
        "contest.problem_effective_version_policy_changed",
        {
          action: "contest.problem_effective_version_policy_changed",
          contest_id: contestId,
          problem_id: problemId,
          from_mode: result.previous.mode,
          to_mode: result.policy.mode,
          required_version_id: result.policy.mode === "exact"
            ? result.policy.version_id
            : null,
          expected_revision: input.expectedRevision,
          affected_submissions: result.affected_submissions,
        },
        { type: "contest_problem", id: `${contestId}:${problemId}` },
      );
    } catch {
      // 同上：审计失败不回滚已生效的策略
    }
  }

  return {
    policy: result.policy,
    revision: result.revision,
    affected_submissions: result.affected_submissions,
  };
}

/**
 * 升级竞赛固定作答版本（§2.6、§4.5）。
 *
 * - 固定版本升级**本身不撤销旧成绩**：是否继续有效由当时策略决定；
 * - 可同时提交新策略；若现有策略是 `exact` 且与新固定版本冲突，而没有同时给出
 *   新策略，返回 409（不静默改动策略）。
 */
export async function upgradeContestProblemPinnedVersion(
  contestId: string,
  problemId: string,
  input: {
    versionId: string;
    /** 可选：同一请求内一起切换策略。 */
    policy?: EffectiveVersionPolicy;
    expectedRevision?: number | null;
    actorId?: string | null;
  },
): Promise<PolicyChangeResult & { pinned_version_id: string }> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // §5.1 固定锁序：题目先于竞赛（与批量受理、逐条策略入口同序）。
    await lockEffectivePolicyHosts(tx, {
      problemIds: [problemId],
      contestIds: [contestId],
    }, { problemLock: "share" });
    const [row] = await tx.select({
      pinned: contestProblems.pinned_version_id,
      mode: contestProblems.effective_version_mode,
      required: contestProblems.required_version_id,
      revision: contestProblems.effective_policy_revision,
    }).from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    ).for("update");
    if (!row) {
      throw new AppError(
        "该题目不属于此竞赛",
        404,
        "CONTEST_PROBLEM_NOT_FOUND",
      );
    }
    if (
      input.expectedRevision != null && row.revision !== input.expectedRevision
    ) {
      throw policyRevisionConflict(input.expectedRevision, row.revision);
    }
    const loaded = await loadPublishedVersionContent(
      problemId,
      input.versionId,
      tx,
    );
    if (!loaded) {
      throw new AppError(
        `目标版本不存在或未发布：${input.versionId}`,
        404,
        "PROBLEM_VERSION_NOT_FOUND",
      );
    }

    // 确定本次生效的策略
    let policy: EffectiveVersionPolicy = input.policy ??
      (row.mode === "exact"
        ? { mode: "exact", version_id: row.required as string }
        : { mode: "any" });
    if (input.policy) {
      await assertPolicyVersionUsable(problemId, input.policy, tx);
    }
    if (policy.mode === "exact" && policy.version_id !== input.versionId) {
      if (!input.policy) {
        throw contestPolicyConflict(input.versionId, policy.version_id);
      }
      throw new AppError(
        "exact 策略的要求版本必须等于固定作答版本",
        409,
        "CONTEST_PROBLEM_VERSION_POLICY_CONFLICT",
      );
    }
    // 固定版本升级即等于 exact(X) 的 X：保持策略自洽
    if (policy.mode === "exact") {
      policy = { mode: "exact", version_id: input.versionId };
    }

    const columns = policyToColumns(policy);
    const nextRevision = row.revision + 1;
    await tx.update(contestProblems).set({
      pinned_version_id: input.versionId,
      effective_version_mode: columns.effective_version_mode,
      required_version_id: columns.required_version_id,
      effective_policy_revision: nextRevision,
    }).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    );

    const affected = await recomputeContestProblemProjections(
      tx,
      contestId,
      problemId,
    );
    return {
      policy,
      revision: nextRevision,
      affected_submissions: affected,
      pinned_version_id: input.versionId,
      previous: { mode: row.mode, required: row.required },
      previousPinned: row.pinned,
    };
  });

  try {
    await logAudit(
      "contest.problem_version_changed",
      {
        action: "contest.problem_version_changed",
        contest_id: contestId,
        problem_id: problemId,
        from_version_id: result.previousPinned,
        to_version_id: result.pinned_version_id,
      },
      { type: "contest_problem", id: `${contestId}:${problemId}` },
    );
  } catch {
    // 同上
  }

  return {
    policy: result.policy,
    revision: result.revision,
    affected_submissions: result.affected_submissions,
    pinned_version_id: result.pinned_version_id,
  };
}
