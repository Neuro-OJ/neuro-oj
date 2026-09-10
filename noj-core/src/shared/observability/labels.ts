/**
 * 指标标签白名单与低基数校验。
 */

import type { MetricLabels } from "./contracts.ts";

export const LABEL_WHITELIST = [
  "method",
  "route",
  "status",
  "queue",
  "provider",
  "language",
  "result",
  "type",
  "criticality",
] as const;

export const MAX_LABEL_VALUE_LENGTH = 64;
export const MAX_SERIES_PER_METRIC = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export function validateLabels(
  _name: string,
  labels: MetricLabels | undefined,
  allowedLabels: readonly string[] | undefined,
): string[] {
  const errors: string[] = [];
  if (!labels) return errors;
  const entries = Object.entries(labels);
  if (entries.length > 5) errors.push("标签数量超过 5");
  for (const [key, value] of entries) {
    if (allowedLabels && !allowedLabels.includes(key)) {
      errors.push(`标签不在白名单: ${key}`);
    }
    if (!LABEL_WHITELIST.includes(key as (typeof LABEL_WHITELIST)[number])) {
      errors.push(`标签不在全局白名单: ${key}`);
    }
    const str = String(value);
    if (str.length > MAX_LABEL_VALUE_LENGTH) errors.push(`标签值过长: ${key}`);
    if (UUID_RE.test(str)) errors.push(`标签值疑似动态 ID: ${key}`);
  }
  return errors;
}
