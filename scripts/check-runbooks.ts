/**
 * Runbook 链接检查。
 *
 * 校验运维告警（noj-alerts.yml）与 SLO 告警（noj-slo-alerts.yml）中
 * runbook 路径存在，且检查确实覆盖到了注解（零注解视为配置异常）。
 */

import { resolve } from "node:path";

const RUNBOOK_RE = /runbook:\s*["']?([^"'\s]+)["']?/g;

const ALERT_FILES = [
  "deploy/monitoring/noj-alerts.yml",
  "deploy/monitoring/noj-slo-alerts.yml",
] as const;

export async function checkRunbooks(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const relativePath of ALERT_FILES) {
    const alertsPath = resolve(root, relativePath);
    let alerts = "";
    try {
      alerts = await Deno.readTextFile(alertsPath);
    } catch {
      errors.push(`告警规则文件不存在: ${relativePath}`);
      continue;
    }
    for (const m of alerts.matchAll(RUNBOOK_RE)) {
      const runbook = m[1];
      if (!runbook || seen.has(runbook)) continue;
      seen.add(runbook);
      const pathPart = runbook.split("#", 1)[0] ?? runbook;
      try {
        await Deno.stat(resolve(root, pathPart));
      } catch {
        errors.push(`Runbook 不存在: ${runbook}（来自 ${relativePath}）`);
      }
    }
  }
  // 零注解说明正则失配或注解被整体删除，此时检查已失去意义，必须失败而非静默通过。
  if (seen.size === 0 && errors.length === 0) {
    errors.push("未发现任何 runbook 注解，检查已失去意义");
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkRunbooks(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("Runbook 链接检查通过");
}
