/**
 * 实例 LLM 配额政策的持久化与管理操作（P5）。
 *
 * 设计要点（交接文档 §5.1）：
 * - 政策事实**只**存在于 Gateway 本地 `llm_policy` 单行；Core 不再是被查询的权威；
 * - 每次管理写入必须携带 operation ID 与预期 revision：
 *   - 同 ID 同请求 → 返回原结果（幂等重试）；
 *   - 同 ID 不同请求 → 拒绝（`OPERATION_CONFLICT`）；
 *   - 旧 revision → 409（`POLICY_REVISION_CONFLICT`）；
 * - 政策、操作结果与审计在同一事务提交；
 * - 预占路径通过 `lockCurrentPolicy` 锁定同一行，因此"降额提交之后开始的新预占
 *   必然读到新政策"，而已完成预占的调用按原账本结算。
 */
import type { Db } from "./db.ts";
import type { QuotaRow } from "./limits.ts";
import type { DomainQuotaCaps } from "./quota-policy.ts";
import { POLICY_RESERVATION_ADVISORY_LOCK } from "./policy-lock.ts";

/** 单行政策的固定主键。 */
export const INSTANCE_POLICY_ID = "instance";

/** 政策快照（含 revision）。 */
export interface InstancePolicy {
  readonly revision: number;
  readonly day: QuotaRow;
  readonly month: QuotaRow;
  readonly updated_at: string;
}

/** 政策写入输入；所有上限可空表示"不额外限制"。 */
export interface PolicyCapsInput {
  readonly day: QuotaRow;
  readonly month: QuotaRow;
}

/** 管理操作结果。 */
export interface PolicyOperationResult {
  readonly operation_id: string;
  readonly status: "applied" | "rejected" | "conflict";
  readonly revision: number;
  readonly policy?: InstancePolicy;
  readonly error_code?: string;
}

/** 稳定错误码。 */
export const POLICY_ERRORS = {
  operationConflict: "OPERATION_CONFLICT",
  revisionConflict: "POLICY_REVISION_CONFLICT",
  invalidCaps: "INVALID_POLICY_CAPS",
} as const;

/** 校验上限值：必须是 null 或非负安全整数。 */
export function validateCaps(input: unknown): PolicyCapsInput {
  const windows = ["day", "month"] as const;
  const fields = ["max_calls", "max_tokens", "max_cost"] as const;
  if (typeof input !== "object" || input === null) {
    throw new Error(POLICY_ERRORS.invalidCaps);
  }
  const record = input as Record<string, unknown>;
  const out: Record<string, QuotaRow> = {};
  for (const window of windows) {
    const raw = record[window];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(POLICY_ERRORS.invalidCaps);
    }
    const row = raw as Record<string, unknown>;
    const value: Record<string, number | null> = {};
    for (const field of fields) {
      const candidate = row[field];
      if (candidate === undefined) {
        value[field] = null;
        continue;
      }
      if (candidate === null) {
        value[field] = null;
        continue;
      }
      if (
        typeof candidate !== "number" || !Number.isSafeInteger(candidate) ||
        candidate < 0
      ) {
        throw new Error(POLICY_ERRORS.invalidCaps);
      }
      value[field] = candidate;
    }
    out[window] = value as unknown as QuotaRow;
  }
  return { day: out.day, month: out.month };
}

/** 规范化政策 JSON 的摘要输入（字段顺序固定，便于稳定比较）。 */
export function canonicalPolicyJson(caps: PolicyCapsInput): string {
  const row = (quota: QuotaRow) =>
    `{"max_calls":${quota.max_calls},"max_tokens":${quota.max_tokens},"max_cost":${quota.max_cost}}`;
  return `{"day":${row(caps.day)},"month":${row(caps.month)}}`;
}

/** 计算请求摘要（SHA-256 十六进制）。 */
export async function policyRequestDigest(
  caps: PolicyCapsInput,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPolicyJson(caps)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 默认空政策（无额外限制）。 */
export function emptyPolicyCaps(): PolicyCapsInput {
  return {
    day: { max_calls: null, max_tokens: null, max_cost: null },
    month: { max_calls: null, max_tokens: null, max_cost: null },
  };
}

/** 把数据库行映射为政策快照。 */
function rowToPolicy(row: {
  revision: number;
  day_max_calls: number | null;
  day_max_tokens: number | null;
  day_max_cost: number | null;
  month_max_calls: number | null;
  month_max_tokens: number | null;
  month_max_cost: number | null;
  updated_at: string;
}): InstancePolicy {
  return {
    revision: row.revision,
    day: {
      max_calls: row.day_max_calls,
      max_tokens: row.day_max_tokens,
      max_cost: row.day_max_cost,
    },
    month: {
      max_calls: row.month_max_calls,
      max_tokens: row.month_max_tokens,
      max_cost: row.month_max_cost,
    },
    updated_at: row.updated_at,
  };
}

/**
 * 读取当前政策；行不存在时返回空政策（revision 0），不隐式写入。
 *
 * 预占路径必须用 {@link lockCurrentPolicy}（加锁读），这里只用于管理端展示。
 */
export async function readCurrentPolicy(db: Db): Promise<InstancePolicy> {
  const rows = await db`
    SELECT revision, day_max_calls, day_max_tokens, day_max_cost,
           month_max_calls, month_max_tokens, month_max_cost, updated_at
    FROM llm_policy WHERE id = ${INSTANCE_POLICY_ID}
  `;
  if (rows.length === 0) {
    return {
      revision: 0,
      ...emptyPolicyCaps(),
      updated_at: new Date(0).toISOString(),
    };
  }
  return rowToPolicy(rows[0] as Parameters<typeof rowToPolicy>[0]);
}

/**
 * 在事务内锁定政策行并读取；返回 `{ tx, policy }` 由调用方决定提交或回滚。
 *
 * 预占步骤与政策写入共用这一行锁，因此两者的先后顺序由 PostgreSQL 行锁决定。
 */
export async function withLockedPolicy<T>(
  db: Db,
  operation: (tx: Db, policy: InstancePolicy) => Promise<T>,
): Promise<T> {
  const result = await db.begin(async (connection) => {
    const tx = connection as unknown as Db;
    // 与 withReservationLock 的共享 advisory lock 配对，覆盖整个预占边界。
    // 仅依赖 FOR UPDATE 会让预占连接在语句结束后释放行锁，无法冻结政策读取到
    // Redis 预占完成；事务级排他锁在政策提交前保持到整个写事务结束。
    await tx`
      SELECT pg_advisory_xact_lock(
        ${POLICY_RESERVATION_ADVISORY_LOCK.classId},
        ${POLICY_RESERVATION_ADVISORY_LOCK.objectId}
      )
    `;
    // 缺行时先插入空政策（revision 0 = "从未写入"），保证锁与后续读取一定命中
    // 同一行，同时让首次写入仍可用 expectedRevision=0 通过乐观锁。
    await tx`
      INSERT INTO llm_policy (id, revision, updated_at)
      VALUES (${INSTANCE_POLICY_ID}, 0, ${new Date().toISOString()})
      ON CONFLICT (id) DO NOTHING
    `;
    const rows = await tx`
      SELECT revision, day_max_calls, day_max_tokens, day_max_cost,
             month_max_calls, month_max_tokens, month_max_cost, updated_at
      FROM llm_policy WHERE id = ${INSTANCE_POLICY_ID} FOR UPDATE
    `;
    const policy = rowToPolicy(rows[0] as Parameters<typeof rowToPolicy>[0]);
    return await operation(tx, policy);
  });
  return result as T;
}

/**
 * 预占路径读取当前政策（加锁版本由调用方包裹事务）。
 *
 * 只读一次：预占事务内不得再读第二份政策，否则降额与预占之间会出现两个读。
 */
export async function loadCurrentQuotaCapsLocal(
  db: Db,
): Promise<DomainQuotaCaps> {
  const policy = await readCurrentPolicy(db);
  return { day: policy.day, month: policy.month };
}

/** 应用一次政策写入（幂等、乐观锁、审计同事务）。 */
export async function applyPolicyOperationTx(
  db: Db,
  input: {
    operationId: string;
    expectedRevision: number;
    caps: PolicyCapsInput;
    actorId: string;
  },
): Promise<PolicyOperationResult> {
  if (typeof input.operationId !== "string" || !input.operationId.trim()) {
    throw new Error("operation_id_required");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
  ) {
    throw new Error("invalid_expected_revision");
  }
  const digest = await policyRequestDigest(input.caps);
  return await withLockedPolicy(db, async (tx, current) => {
    // 1) 同 operation ID：同请求返回原结果，不同请求拒绝。
    const existing = await tx`
      SELECT operation_id, request_digest, result_revision, status, error_code,
             result
      FROM llm_policy_operations WHERE operation_id = ${input.operationId}
    `;
    if (existing.length > 0) {
      const row = existing[0] as {
        request_digest: string;
        result_revision: number | null;
        status: PolicyOperationResult["status"];
        error_code: string | null;
        result: Record<string, unknown> | null;
      };
      if (row.request_digest !== digest) {
        return {
          operation_id: input.operationId,
          status: "conflict",
          revision: current.revision,
          error_code: POLICY_ERRORS.operationConflict,
        };
      }
      return {
        operation_id: input.operationId,
        status: row.status,
        revision: row.result_revision ?? current.revision,
        ...(row.result
          ? { policy: row.result as unknown as InstancePolicy }
          : {}),
        ...(row.error_code ? { error_code: row.error_code } : {}),
      };
    }

    // 2) 旧 revision：拒绝，并持久化冲突结果（客户端可查询）。
    if (current.revision !== input.expectedRevision) {
      const result: PolicyOperationResult = {
        operation_id: input.operationId,
        status: "conflict",
        revision: current.revision,
        error_code: POLICY_ERRORS.revisionConflict,
      };
      await recordOperation(tx, input, digest, result);
      return result;
    }

    // 3) 写入政策并递增 revision。
    const nextRevision = current.revision + 1;
    const now = new Date().toISOString();
    await tx`
      UPDATE llm_policy SET
        revision = ${nextRevision},
        day_max_calls = ${input.caps.day.max_calls},
        day_max_tokens = ${input.caps.day.max_tokens},
        day_max_cost = ${input.caps.day.max_cost},
        month_max_calls = ${input.caps.month.max_calls},
        month_max_tokens = ${input.caps.month.max_tokens},
        month_max_cost = ${input.caps.month.max_cost},
        updated_at = ${now}
      WHERE id = ${INSTANCE_POLICY_ID}
    `;
    const policy: InstancePolicy = {
      revision: nextRevision,
      day: input.caps.day,
      month: input.caps.month,
      updated_at: now,
    };
    const result: PolicyOperationResult = {
      operation_id: input.operationId,
      status: "applied",
      revision: nextRevision,
      policy,
    };
    await recordOperation(tx, input, digest, result);
    return result;
  });
}

/** 持久化操作结果；调用方已持有政策行锁。 */
async function recordOperation(
  tx: Db,
  input: {
    operationId: string;
    expectedRevision: number;
    caps: PolicyCapsInput;
    actorId: string;
  },
  digest: string,
  result: PolicyOperationResult,
): Promise<void> {
  await tx`
    INSERT INTO llm_policy_operations (
      operation_id, request_digest, expected_revision, result_revision,
      status, error_code, result, actor_id, created_at
    ) VALUES (
      ${input.operationId}, ${digest}, ${input.expectedRevision},
      ${result.revision}, ${result.status}, ${result.error_code ?? null},
      ${result.policy ? JSON.stringify(result.policy) : null}::text::jsonb,
      ${input.actorId}, ${new Date().toISOString()}
    )
    ON CONFLICT (operation_id) DO NOTHING
  `;
}

/** 按 operation ID 查询持久结果；不存在返回 null。 */
export async function readPolicyOperation(
  db: Db,
  operationId: string,
): Promise<PolicyOperationResult | null> {
  const rows = await db`
    SELECT operation_id, status, result_revision, error_code, result
    FROM llm_policy_operations WHERE operation_id = ${operationId}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as {
    operation_id: string;
    status: PolicyOperationResult["status"];
    result_revision: number | null;
    error_code: string | null;
    result: Record<string, unknown> | null;
  };
  return {
    operation_id: row.operation_id,
    status: row.status,
    revision: row.result_revision ?? 0,
    ...(row.result ? { policy: row.result as unknown as InstancePolicy } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
  };
}

/** 仅供测试：清空政策与操作日志。 */
export async function _resetPolicyForTest(db: Db): Promise<void> {
  await db`DELETE FROM llm_policy_operations`;
  await db`DELETE FROM llm_policy`;
}

/**
 * 预占步骤读取政策：**共享锁**读同一行。
 *
 * 语义（交接文档 §5.2）：
 * - 预占与政策写入争用同一行的锁：`FOR SHARE` 与政策写入的 `FOR UPDATE` 互斥；
 * - 已完成预占的调用按原账本结算（其 counters 已冻结在 ledger 中）；
 * - 政策写入提交后开始的新预占必然读到新政策（行锁保证读发生在提交之后）。
 *
 * 使用共享锁而不是排他锁：并发预占之间不互相阻塞，只有政策写入会等待。
 */
export async function readPolicyForReservation(
  tx: Db,
): Promise<DomainQuotaCaps> {
  // 缺行时先建立空政策行，避免"无行可锁"导致政策写入与预占之间没有共同锁点。
  await tx`
    INSERT INTO llm_policy (id, revision, updated_at)
    VALUES (${INSTANCE_POLICY_ID}, 0, ${new Date().toISOString()})
    ON CONFLICT (id) DO NOTHING
  `;
  const rows = await tx`
    SELECT revision, day_max_calls, day_max_tokens, day_max_cost,
           month_max_calls, month_max_tokens, month_max_cost, updated_at
    FROM llm_policy WHERE id = ${INSTANCE_POLICY_ID} FOR SHARE
  `;
  const policy = rowToPolicy(rows[0] as Parameters<typeof rowToPolicy>[0]);
  return { day: policy.day, month: policy.month };
}
