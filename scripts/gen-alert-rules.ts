/**
 * 从 SLO 定义生成/校验 Prometheus 告警规则。
 *
 * 只生成 SLO 规则文件 deploy/monitoring/noj-slo-alerts.yml；
 * 运维告警保留在 deploy/monitoring/noj-alerts.yml，避免生成器覆盖历史规则。
 *
 * 用法：
 *   deno run -A scripts/gen-alert-rules.ts            # 生成
 *   deno run -A scripts/gen-alert-rules.ts --check    # 校验无漂移
 */

import { resolve } from "node:path";
import {
  type SloDefinition,
  SLOS,
} from "../noj-core/src/domains/observability/slo.ts";

export const SLO_ALERTS_RELATIVE_PATH = "deploy/monitoring/noj-slo-alerts.yml";

function yamlEscape(value: string): string {
  return /[:#\n]/.test(value) ? JSON.stringify(value) : value;
}

function alertName(id: string): string {
  return "NojSlo" +
    id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(
      / /g,
      "",
    );
}

function renderRatioRules(lines: string[], slo: SloDefinition): void {
  if (slo.kind !== "ratio") return;
  const id = slo.id;
  lines.push(`      - record: noj:slo:${id}:burn_rate`);
  lines.push(`        expr: |`);
  lines.push(
    `          (1 - (${slo.sli})) / (1 - ${slo.objective})`,
  );
  lines.push(`      - alert: ${alertName(id)}Fast`);
  lines.push(`        expr: noj:slo:${id}:burn_rate > 1`);
  lines.push(`        for: ${slo.holdFor.short}`);
  lines.push(`        labels:`);
  lines.push(`          severity: ${slo.severity}`);
  lines.push(`          slo: ${id}`);
  lines.push(`        annotations:`);
  lines.push(`          summary: ${yamlEscape(slo.title)} 错误预算消耗过快`);
  lines.push(`          runbook: ${slo.runbook}`);
  lines.push(`      - alert: ${alertName(id)}Slow`);
  lines.push(`        expr: noj:slo:${id}:burn_rate > 1`);
  lines.push(`        for: ${slo.holdFor.long}`);
  lines.push(`        labels:`);
  lines.push(`          severity: warning`);
  lines.push(`          slo: ${id}`);
  lines.push(`        annotations:`);
  lines.push(
    `          summary: ${yamlEscape(slo.title)} 错误预算持续消耗（慢速告警）`,
  );
  lines.push(`          runbook: ${slo.runbook}`);
}

function renderThresholdRules(lines: string[], slo: SloDefinition): void {
  if (slo.kind !== "threshold") return;
  const id = slo.id;
  const condition = `(${slo.sli} ${slo.comparison} ${slo.objective})`;
  const expr = slo.guard ? `${condition} and (${slo.guard})` : condition;
  lines.push(`      - alert: ${alertName(id)}`);
  lines.push(`        expr: ${expr}`);
  lines.push(`        for: ${slo.forDuration}`);
  lines.push(`        labels:`);
  lines.push(`          severity: ${slo.severity}`);
  lines.push(`          slo: ${id}`);
  lines.push(`        annotations:`);
  lines.push(`          summary: ${yamlEscape(slo.title)} 低于/超过 SLO 阈值`);
  lines.push(`          runbook: ${slo.runbook}`);
}

export function renderSloRules(): string {
  const lines: string[] = [
    "groups:",
    "  - name: noj-slo",
    "    rules:",
  ];
  for (const slo of SLOS) {
    if (slo.kind === "ratio") {
      renderRatioRules(lines, slo);
    } else {
      renderThresholdRules(lines, slo);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function genAlertRules(
  root = ".",
  check = false,
): Promise<string[]> {
  const path = resolve(root, SLO_ALERTS_RELATIVE_PATH);
  const generated = renderSloRules();
  if (check) {
    const current = await Deno.readTextFile(path).catch(() => "");
    return current.trim() === generated.trim() ? [] : [
      `${SLO_ALERTS_RELATIVE_PATH} 与 SLO 定义不一致，请运行 gen-alert-rules.ts 重新生成`,
    ];
  }
  await Deno.writeTextFile(path, generated);
  return [];
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const errors = await genAlertRules(".", check);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log(
    check
      ? "SLO 告警规则与 SLO 定义一致"
      : `已生成 ${SLO_ALERTS_RELATIVE_PATH}`,
  );
}
