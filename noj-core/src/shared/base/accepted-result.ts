import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

/** OI 依据 verdict，AI 保留已评测且正分的原有通过语义。 */
export function isAcceptedResult(
  status: string | null,
  score: number,
  details: unknown,
): boolean {
  if (status !== "finished") return false;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      return score > 0;
    }
  }
  const oi = details && typeof details === "object"
    ? (details as Record<string, unknown>).oi
    : undefined;
  return oi && typeof oi === "object"
    ? (oi as Record<string, unknown>).verdict === "AC"
    : score > 0;
}

/** details 由结果服务 JSON 序列化入库；SQL 与页面统计共用通过判定。 */
export function acceptedResultSql(
  status: SQLWrapper,
  score: SQLWrapper,
  details: SQLWrapper,
): SQL {
  return sql`(${status} = 'finished' AND CASE WHEN jsonb_typeof((${details})::jsonb -> 'oi') = 'object'
    THEN (${details})::jsonb #>> '{oi,verdict}' = 'AC' ELSE ${score} > 0 END)`;
}
