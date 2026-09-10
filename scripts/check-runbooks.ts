/**
 * Runbook 链接检查。
 *
 * 校验 deploy/monitoring/noj-alerts.yml 中 runbook 路径存在。
 */

import { resolve } from "node:path";

const RUNBOOK_RE = /runbook:\s*["']?([^"'\s]+)["']?/g;

export async function checkRunbooks(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const alertsPath = resolve(root, "deploy/monitoring/noj-alerts.yml");
  const alerts = await Deno.readTextFile(alertsPath);
  for (const m of alerts.matchAll(RUNBOOK_RE)) {
    const runbook = m[1];
    if (!runbook) continue;
    try {
      await Deno.stat(resolve(root, runbook));
    } catch {
      errors.push(`Runbook 不存在: ${runbook}`);
    }
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
