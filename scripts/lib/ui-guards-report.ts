/**
 * noj-ui 设计系统守卫：`--report` 的文本表与 JSON 段。
 *
 * 表格列名保持 ASCII（`rule` / `S1` / `public` / `all`），否则 CJK 列宽与终端
 * 实际宽度对不上，数字列会跳。
 */

import { RULE_NAMES, type RuleName } from "./ui-guards-rules.ts";
import { type Scan, SCOPE_LABELS, SCOPE_NAMES } from "./ui-guards-scan.ts";

function sum(counts: Record<RuleName, number>): number {
  return RULE_NAMES.reduce((acc, rule) => acc + counts[rule], 0);
}

/** 三 scope 的文本表。 */
export function renderTable(scan: Scan): string {
  const header = ["rule", ...SCOPE_NAMES.map((scope) => SCOPE_LABELS[scope])];
  const rows = RULE_NAMES.map((rule) => [
    rule,
    ...SCOPE_NAMES.map((scope) => String(scan[scope].counts[rule])),
  ]);
  rows.push([
    "total",
    ...SCOPE_NAMES.map((scope) => String(sum(scan[scope].counts))),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const lines = [
    "设计系统守卫实测（数字 = 命中次数，不是文件数；基线只比对数字）：",
    "  S1     = 首要治理域（排除 admin / editor / problem/ui / objective / 设置 等）",
    "  public = noj-ui/pages + noj-ui/components，排除 admin",
    "  all    = 全量（含 admin，只统计、不设目标）",
    "",
    "  " +
    header.map((h, i) => i === 0 ? h.padEnd(widths[i]) : h.padStart(widths[i]))
      .join("  "),
  ];
  for (const row of rows) {
    lines.push(
      "  " +
        row.map((cell, i) =>
          i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])
        ).join("  "),
    );
  }
  lines.push(
    "",
    `  扫描文件数：${
      SCOPE_NAMES.map((scope) => `${SCOPE_LABELS[scope]}=${scan[scope].files}`)
        .join("  ")
    }`,
  );
  return lines.join("\n");
}

/** `--report` 的 JSON 段：文件数 + 计数（可直接对照基线）。 */
export function renderReportJson(scan: Scan): string {
  return JSON.stringify(
    {
      files: Object.fromEntries(
        SCOPE_NAMES.map((scope) => [scope, scan[scope].files]),
      ),
      counts: Object.fromEntries(
        SCOPE_NAMES.map((scope) => [scope, scan[scope].counts]),
      ),
    },
    null,
    2,
  );
}

/** 一行摘要，用于通过/写基线的日志。 */
export function summarize(scan: Scan): string {
  return SCOPE_NAMES.map((scope) =>
    `${SCOPE_LABELS[scope]} 合计 ${sum(scan[scope].counts)} 处 / ${
      scan[scope].files
    } 文件`
  ).join("，");
}
