import type { GatewayConfig } from "./config.ts";
import type { QuotaRow } from "./limits.ts";

export interface DomainQuotaCaps {
  day: QuotaRow;
  month: QuotaRow;
}

/** 每次调用读取持久实例政策，降低上限不等待 token 到期或缓存失效。 */
export async function loadCurrentQuotaCaps(
  config: GatewayConfig,
): Promise<DomainQuotaCaps> {
  try {
    const response = await fetch(
      config.coreInternalUrl.replace(/\/+$/, "") +
        "/api/v1/internal/llm/quota-caps",
      {
        headers: { Authorization: "Bearer " + config.serviceToken },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("policy_unavailable");
    const { data } = await response.json();
    for (const window of ["day", "month"]) {
      for (const field of ["max_calls", "max_tokens", "max_cost"]) {
        const value = data?.[window]?.[field];
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
          throw new Error("invalid_policy");
        }
      }
    }
    return data;
  } catch {
    throw new Error("quota_policy_unavailable");
  }
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
