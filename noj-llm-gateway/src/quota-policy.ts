import type { Db } from "./db.ts";
import type { QuotaRow } from "./limits.ts";
import { readCurrentPolicy } from "./policy-operations.ts";

export interface DomainQuotaCaps {
  day: QuotaRow;
  month: QuotaRow;
}

/**
 * 读取实例政策上限（P5：Gateway 本地持久权威）。
 *
 * 旧实现每次调用都 fetch Core 的 `/api/v1/internal/llm/quota-caps`：
 * - Core 不可达时整条 LLM 链路 503；
 * - 排队前后可能读到两份不同政策（降额生效时序不确定）；
 * - Core 侧保留第二份可写权威。
 *
 * 现在政策只存在于 Gateway 的 `llm_policy` 单行：
 * - 不发起任何 Core 请求；
 * - 预占步骤在事务内锁定该行，政策写入与预占由同一行锁定序决定先后；
 * - 行不存在时返回空政策（不隐式创建），空政策表示"不额外限制"。
 */
export async function loadCurrentQuotaCaps(db: Db): Promise<DomainQuotaCaps> {
  const policy = await readCurrentPolicy(db);
  return { day: policy.day, month: policy.month };
}

/** null 不能解除另一层数值限制。 */
export function capDomainQuota(
  quota: QuotaRow | null,
  cap?: QuotaRow,
): QuotaRow | null {
  if (!cap) return quota;
  const min = (local: number | null | undefined, upper: number | null) =>
    local == null ? upper : upper === null ? local : Math.min(local, upper);
  return {
    max_calls: min(quota?.max_calls, cap.max_calls),
    max_tokens: min(quota?.max_tokens, cap.max_tokens),
    max_cost: min(quota?.max_cost, cap.max_cost),
  };
}
