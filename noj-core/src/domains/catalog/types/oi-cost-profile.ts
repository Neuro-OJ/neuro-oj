/** 由受信硬件校准并由 system 域启用的 WASM 成本快照；用户题目配置不能指定。 */
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
}

/** 检查任务成本快照的结构；启用时的可信校准验证由 system 域负责。 */
export function isValidOiCostProfile(value: unknown): value is OiCostProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as OiCostProfile;
  const validCosts = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.values(v).every((n) => Number.isInteger(n) && n >= 1 && n <= 255);
  return p.schema_version === 1 && typeof p.runtime_version === "string" &&
    p.runtime_version.length > 0 && typeof p.hash === "string" &&
    /^[a-f0-9]{64}$/.test(p.hash) && validCosts(p.costs) &&
    Object.keys(p.costs).length > 0 && validCosts(p.variable_costs) &&
    Number.isSafeInteger(p.io_fuel_per_byte) && p.io_fuel_per_byte > 0 &&
    Number.isFinite(p.fuel_per_ms) && p.fuel_per_ms > 0;
}
