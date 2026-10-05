/** OI 用户判定与提交生命周期独立。 */
export const OI_VERDICTS = [
  "AC",
  "WA",
  "TLE",
  "MLE",
  "OLE",
  "RE",
  "CE",
  "SE",
  "FE",
  "IGN",
] as const;
export type OiVerdict = typeof OI_VERDICTS[number];
const META = [
  "verdict",
  "backend",
  "score",
  "max_score",
  "time_ms",
  "cpu_time_ms",
  "wall_time_ms",
  "equivalent_time_ms",
  "memory_kb",
  "cost_profile_hash",
  "compile_error",
];
const SUBTASK_META = [
  "id",
  "score",
  "max_score",
  "verdict",
  "status",
  "depends_on",
];
const CASE_META = [
  "case_id",
  "id",
  "verdict",
  "status",
  "time_ms",
  "cpu_time_ms",
  "wall_time_ms",
  "equivalent_time_ms",
  "fuel_consumed",
  "fuel_budget",
  "termination_reason",
  "memory_kb",
  "hidden",
  "visibility",
];
function pick(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(src, key)).map((key) => [key, src[key]]),
  );
}
function projectCase(value: unknown): Record<string, unknown> {
  const projected = pick(value, CASE_META);
  if (projected.termination_reason !== "host_watchdog") {
    delete projected.termination_reason;
  }
  return projected;
}
/** OI 详情一律仅返回判定与资源元数据，隐藏数据和checker诊断不能通过所有者绕过。 */
export function projectOiDetails(value: unknown): Record<string, unknown> {
  const result = pick(value, META);
  if (!value || typeof value !== "object") return result;
  const src = value as Record<string, unknown>;
  if (Array.isArray(src.subtasks)) {
    result.subtasks = src.subtasks.slice(0, 100).map((v) => {
      const s = pick(v, SUBTASK_META);
      if (v && typeof v === "object" && Array.isArray(v.cases)) {
        s.cases = v.cases.slice(0, 100).map((c: unknown) => projectCase(c));
      }
      return s;
    });
  }
  if (Array.isArray(src.cases)) {
    result.cases = src.cases.slice(0, 100).map(projectCase);
  }
  return result;
}
/** 取得合法只读判定。 */
export function oiVerdict(details: unknown): OiVerdict | undefined {
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      return undefined;
    }
  }
  if (!details || typeof details !== "object") return undefined;
  const oi = (details as Record<string, unknown>).oi;
  if (!oi || typeof oi !== "object") return undefined;
  const verdict = (oi as Record<string, unknown>).verdict;
  return OI_VERDICTS.includes(verdict as OiVerdict)
    ? verdict as OiVerdict
    : undefined;
}

/** 仅投影公开可比标识，禁止泄露源码、隐藏数据和任意诊断字段。 */
export function projectMeteringDetails(
  value: unknown,
): Record<string, unknown> {
  const result = pick(value, [
    "standard_version",
    "standard_hash",
    "source_hash",
    "evaluation_hash",
    "module_hash",
    "checker_module_hash",
    "comparison_hash",
    "comparable",
    "termination_reason",
  ]);
  for (
    const key of [
      "standard_hash",
      "source_hash",
      "evaluation_hash",
      "module_hash",
      "checker_module_hash",
      "comparison_hash",
    ]
  ) {
    if (
      typeof result[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(result[key] as string)
    ) delete result[key];
  }
  if (
    typeof result.standard_version !== "string" ||
    !/^noj-wasm-v[0-9]+$/.test(result.standard_version)
  ) delete result.standard_version;
  if (
    !["host_watchdog", "standard_mismatch"].includes(
      result.termination_reason as string,
    )
  ) delete result.termination_reason;
  result.legacy = typeof result.standard_version !== "string";
  result.comparable = result.comparable === true && !result.legacy &&
    ["standard_hash", "source_hash", "evaluation_hash", "comparison_hash"]
      .every((key) => typeof result[key] === "string");
  return result;
}
