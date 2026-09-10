/**
 * 从 SLO 定义生成/校验 Prometheus 告警规则。
 *
 * 用法：
 *   deno run -A scripts/gen-alert-rules.ts            # 生成
 *   deno run -A scripts/gen-alert-rules.ts --check    # 校验无漂移
 */

import { resolve } from "node:path";
import { SLOS } from "../noj-core/src/domains/observability/slo.ts";

function yamlEscape(value: string): string {
  return /[:#\n]/.test(value) ? JSON.stringify(value) : value;
}

export function renderSloRules(): string {
  const lines: string[] = [
    "groups:",
    "  - name: noj-slo-burn-rate",
    "    rules:",
  ];
  for (const slo of SLOS) {
    const id = slo.id;
    lines.push(`      - record: noj:slo:${id}:burn_rate`);
    lines.push(`        expr: |`);
    lines.push(`          (1 - ${slo.sli}) / (1 - ${slo.objective})`);
    const alertName = "NojSloBurnRate" +
      id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(
        / /g,
        "",
      );
    lines.push(`      - alert: ${alertName}`);
    lines.push(`        expr: noj:slo:${id}:burn_rate > 1`);
    lines.push(`        for: ${slo.burnRateWindows.short}`);
    lines.push(`        labels:`);
    lines.push(`          severity: critical`);
    lines.push(`          slo: ${id}`);
    lines.push(`        annotations:`);
    lines.push(`          summary: ${yamlEscape(slo.title)} 错误预算消耗过快`);
    lines.push(`          runbook: ${slo.runbook}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function genAlertRules(
  root = ".",
  check = false,
): Promise<string[]> {
  const path = resolve(root, "deploy/monitoring/noj-alerts.yml");
  const generated = renderSloRules();
  if (check) {
    const current = await Deno.readTextFile(path);
    return current.trim() === generated.trim() ? [] : [
      "noj-alerts.yml 与 SLO 定义不一致，请运行 gen-alert-rules.ts 重新生成",
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
  console.log(check ? "告警规则与 SLO 一致" : "已生成 noj-alerts.yml");
}
