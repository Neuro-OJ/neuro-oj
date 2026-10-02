/**
 * OI WASM 硬件校准。
 *
 * 该模块只接受评测 worker 产生的基准样本，不会用默认值伪造测量结果。
 * 输入必须同时包含训练集与独立留出集；输出中的 measurement_verified 只有在
 * 调用者明确传入 --measurement-verified 时才为 true，便于审计报告区分演练结果。
 */

import { UsageError } from "../../util/args.ts";

export interface CalibrationSample {
  category: string;
  features: Record<string, number>;
  observed_time_ms: number;
}

export interface CalibrationInput {
  runtime_version: string;
  toolchain?: string;
  hardware?: string;
  samples: CalibrationSample[];
  holdout_samples: CalibrationSample[];
}

export interface CalibrationProfile {
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
  validation: {
    p95_relative_error: number;
    category_median_relative_error: number;
    holdout_samples: number;
    measurement_verified: boolean;
  };
}

const MAX_FEATURE_COST = 255;
const P95_LIMIT = 0.25;
const CATEGORY_MEDIAN_LIMIT = 0.2;
/** 这些名称与 Wasmtime 49 的 VariableOperatorCost 字段一一对应。 */
const SUPPORTED_VARIABLE_COSTS = new Set([
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
]);

function asFinitePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${field} 必须是有限正数`);
  }
  return value;
}

function parseSample(value: unknown, index: number): CalibrationSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`基准样本 ${index} 不是对象`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.category !== "string" || record.category.trim() === "") {
    throw new UsageError(`基准样本 ${index}.category 不能为空`);
  }
  if (
    !record.features || typeof record.features !== "object" ||
    Array.isArray(record.features)
  ) {
    throw new UsageError(`基准样本 ${index}.features 必须是对象`);
  }
  const features: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record.features)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new UsageError(`基准样本 ${index} 的特征名非法: ${key}`);
    }
    if (!SUPPORTED_VARIABLE_COSTS.has(key)) {
      throw new UsageError(
        `基准样本 ${index} 使用了运行时未支持的变量成本特征: ${key}`,
      );
    }
    features[key] = asFinitePositive(raw, `基准样本 ${index}.features.${key}`);
  }
  if (Object.keys(features).length === 0) {
    throw new UsageError(`基准样本 ${index} 至少需要一个特征`);
  }
  return {
    category: record.category.trim(),
    features,
    observed_time_ms: asFinitePositive(
      record.observed_time_ms,
      `基准样本 ${index}.observed_time_ms`,
    ),
  };
}

export function parseCalibrationInput(value: unknown): CalibrationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("校准输入必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.runtime_version !== "string" ||
    record.runtime_version.trim() === ""
  ) {
    throw new UsageError("runtime_version 不能为空");
  }
  if (!Array.isArray(record.samples) || record.samples.length < 3) {
    throw new UsageError("训练样本至少需要 3 条");
  }
  if (
    !Array.isArray(record.holdout_samples) || record.holdout_samples.length < 1
  ) {
    throw new UsageError("必须提供独立 holdout_samples");
  }
  return {
    runtime_version: record.runtime_version.trim(),
    toolchain: typeof record.toolchain === "string"
      ? record.toolchain
      : undefined,
    hardware: typeof record.hardware === "string" ? record.hardware : undefined,
    samples: record.samples.map(parseSample),
    holdout_samples: record.holdout_samples.map(parseSample),
  };
}

function featureNames(samples: CalibrationSample[]): string[] {
  return [...new Set(samples.flatMap((sample) => Object.keys(sample.features)))]
    .sort();
}

/** 用带 L2 正则的坐标下降拟合非负线性模型。 */
function fitNonNegative(
  samples: CalibrationSample[],
  names: string[],
  regularization = 1e-6,
): Record<string, number> {
  const coefficients = new Array<number>(names.length).fill(0);
  for (let iteration = 0; iteration < 500; iteration++) {
    let maxDelta = 0;
    for (let featureIndex = 0; featureIndex < names.length; featureIndex++) {
      const name = names[featureIndex]!;
      let numerator = 0;
      let denominator = regularization;
      for (const sample of samples) {
        const x = sample.features[name] ?? 0;
        let residual = sample.observed_time_ms;
        for (let i = 0; i < names.length; i++) {
          if (i === featureIndex) continue;
          residual -= (sample.features[names[i]!] ?? 0) * coefficients[i]!;
        }
        numerator += x * residual;
        denominator += x * x;
      }
      const next = Math.max(0, numerator / denominator);
      maxDelta = Math.max(
        maxDelta,
        Math.abs(next - coefficients[featureIndex]!),
      );
      coefficients[featureIndex] = next;
    }
    if (maxDelta < 1e-8) break;
  }
  return Object.fromEntries(names.map((name, index) => [
    name,
    Math.min(MAX_FEATURE_COST, Math.max(1, Math.round(coefficients[index]!))),
  ]));
}

function predict(
  sample: CalibrationSample,
  costs: Record<string, number>,
): number {
  return Object.entries(sample.features).reduce(
    (sum, [name, value]) => sum + value * (costs[name] ?? 1),
    0,
  );
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, index)]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function relativeErrors(
  samples: CalibrationSample[],
  costs: Record<string, number>,
): number[] {
  return samples.map((sample) =>
    Math.abs(predict(sample, costs) - sample.observed_time_ms) /
    sample.observed_time_ms
  );
}

function categoryMedianError(
  samples: CalibrationSample[],
  costs: Record<string, number>,
): number {
  const grouped = new Map<string, number[]>();
  for (const sample of samples) {
    const errors = grouped.get(sample.category) ?? [];
    errors.push(
      Math.abs(predict(sample, costs) - sample.observed_time_ms) /
        sample.observed_time_ms,
    );
    grouped.set(sample.category, errors);
  }
  return Math.max(...[...grouped.values()].map(median), 0);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function fitOiCostProfile(
  input: CalibrationInput,
  options: {
    measurementVerified: boolean;
    benchmark?: string;
  },
): Promise<CalibrationProfile> {
  const names = featureNames([...input.samples, ...input.holdout_samples]);
  const costs = fitNonNegative(input.samples, names);
  const errors = relativeErrors(input.holdout_samples, costs);
  const p95 = percentile(errors, 0.95);
  const categoryMedian = categoryMedianError(input.holdout_samples, costs);
  const validation = {
    p95_relative_error: p95,
    category_median_relative_error: categoryMedian,
    holdout_samples: input.holdout_samples.length,
    measurement_verified: options.measurementVerified,
  };
  if (!options.measurementVerified) {
    throw new UsageError(
      "只有明确标记 --measurement-verified 才能生成可启用成本表",
    );
  }
  if (p95 > P95_LIMIT || categoryMedian > CATEGORY_MEDIAN_LIMIT) {
    throw new UsageError(
      `留出集误差未达标：P95=${(p95 * 100).toFixed(2)}%，类别中位最大值=${
        (categoryMedian * 100).toFixed(2)
      }%（要求 25% / 20%）`,
    );
  }
  const profileWithoutHash = {
    schema_version: 1 as const,
    runtime_version: input.runtime_version,
    costs: { default: 1 },
    variable_costs: costs,
    io_fuel_per_byte: 1,
    // 校准特征的系数就是等效 fuel 单位；运行时用同一单位计算
    // `fuel / fuel_per_ms`，因此这里固定为 1，避免再引入未经拟合的缩放。
    fuel_per_ms: 1,
    ...(input.toolchain ? { toolchain: input.toolchain } : {}),
    benchmark: options.benchmark ?? "noj-oi-calibration",
    ...(input.hardware ? { hardware: input.hardware } : {}),
    validation,
  };
  const hash = await sha256Hex(canonicalJson(profileWithoutHash));
  return { ...profileWithoutHash, hash };
}

export async function calibrateFromFile(
  inputPath: string,
  outputPath: string,
  options: { measurementVerified: boolean; benchmark?: string },
): Promise<CalibrationProfile> {
  const text = await Deno.readTextFile(inputPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`校准输入不是合法 JSON：${inputPath}`);
  }
  const profile = await fitOiCostProfile(
    parseCalibrationInput(parsed),
    options,
  );
  await Deno.writeTextFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}
