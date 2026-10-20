import standard from "./noj-wasm-v3.json" with { type: "json" };

/** 由 NOJ 内置统一标准产生的 WASM 成本快照；实例和题目不能修改。 */
export interface OiCostProfile {
  schema_version: 1;
  runtime_version: string;
  costs: Record<string, number>;
  variable_costs: Record<string, number>;
  io_fuel_per_byte: number;
  fuel_per_ms: number;
  hash: string;
  toolchain?: string;
  benchmark?: string;
  hardware?: string;
  validation?: {
    p95_relative_error: number;
    category_median_relative_error: number;
    holdout_samples: number;
    measurement_verified: boolean;
  };
}

/** 必须与 Wasmtime 49 的 VariableOperatorCost 字段保持同一集合。 */
export const OI_VARIABLE_COST_KEYS = [
  "memory_copy_per_byte",
  "memory_fill_per_byte",
  "memory_init_per_byte",
  "memory_grow_per_page",
  "table_copy_per_element",
  "table_fill_per_element",
  "table_init_per_element",
  "table_grow_per_element",
  "array_copy_per_element",
  "array_fill_per_element",
  "array_new_data_per_element",
  "array_init_data_per_element",
  "array_new_elem_per_element",
  "array_init_elem_per_element",
  "array_new_default_per_element",
  "array_new_per_element",
] as const;

/** 检查任务成本快照的结构；启用时的可信校准验证由 system 域负责。 */
export function isValidOiCostProfile(value: unknown): value is OiCostProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as OiCostProfile;
  const validCosts = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.values(v).every((n) => Number.isInteger(n) && n >= 1 && n <= 255);
  const validVariableCosts = (v: unknown) =>
    validCosts(v) &&
    Object.keys(v as object).every((key) =>
      (OI_VARIABLE_COST_KEYS as readonly string[]).includes(key)
    );
  return p.schema_version === 1 && typeof p.runtime_version === "string" &&
    p.runtime_version === "wasmtime-49" && typeof p.hash === "string" &&
    /^[a-f0-9]{64}$/.test(p.hash) && validCosts(p.costs) &&
    Object.keys(p.costs).length === 1 && p.costs.default === 1 &&
    validVariableCosts(p.variable_costs) &&
    Number.isSafeInteger(p.io_fuel_per_byte) && p.io_fuel_per_byte > 0 &&
    Number.isFinite(p.fuel_per_ms) && p.fuel_per_ms > 0;
}

/** 返回内置统一成本快照；不读取环境变量或实例设置。 */
export function getBuiltinOiCostProfile(): OiCostProfile {
  return {
    schema_version: 1,
    runtime_version: "wasmtime-49",
    costs: { default: 1 },
    variable_costs: { ...standard.operator_costs.variable },
    io_fuel_per_byte: 1,
    fuel_per_ms: standard.fuel_per_ms,
    hash: standard.hash,
    toolchain: standard.toolchain,
    benchmark: standard.id,
  };
}
/** 返回只读统一标准清单的副本。 */
export function getOiMeteringStandard() {
  return structuredClone(standard);
}
