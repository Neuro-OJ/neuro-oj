/**
 * 判定通过语义（Handbook §1.4）。
 *
 * 与既有读取口径**完全一致**（`acceptedResultSql`，见 query 域）：
 * ```
 * status = 'finished' AND (
 *   details.oi 是对象 ? details.oi.verdict = 'AC' : score > 0
 * )
 * ```
 * 即：OI 题看 verdict 是否为 AC；其余题型沿用「有效正分」规则。
 *
 * 该函数被结果写入（评测尝试的 `accepted` 字段）与读取路径共用，
 * **不允许**任何一侧自行发明第二套通过口径。
 */

/** 判定输入（来自可信结果封套）。 */
export interface AcceptanceInput {
  status: string;
  /** ×100 整数分。 */
  score: number;
  /** 结构化详情（`details`，对象形态）。 */
  details: unknown;
}

/** 判断一次正式判定是否通过。 */
export function isAcceptedResult(input: AcceptanceInput): boolean {
  if (input.status !== "finished") return false;
  const details = input.details && typeof input.details === "object"
    ? input.details as Record<string, unknown>
    : null;
  const oi = details?.oi;
  if (oi && typeof oi === "object" && !Array.isArray(oi)) {
    return (oi as Record<string, unknown>).verdict === "AC";
  }
  return input.score > 0;
}

/**
 * 平台错误状态白名单（旧协议兜底推导用）。
 *
 * 只有**平台侧**故障才算 `platform_error`：用户代码的 TLE/MLE/RE/CE/WA 都是
 * 正式判定（`graded`）——这正是"不能把未通过等同于评测故障"的落点。
 * 新协议下 judge 必须显式给出 `result_kind`，本表只服务旧协议过渡。
 */
export const PLATFORM_ERROR_STATUSES: readonly string[] = [
  "error",
  "SystemError",
  "SE",
  "FE",
  "cancelled",
];

/** 旧协议兜底：由结果状态推导判定类别。 */
export function deriveResultKind(status: string): "graded" | "platform_error" {
  return PLATFORM_ERROR_STATUSES.includes(status) ? "platform_error" : "graded";
}
