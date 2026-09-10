/**
 * 外部运行时契约检查。
 *
 * 校验 HTTP 模式运行时的 Prometheus job 与 gateway fixture 指标齐全。
 */

import { resolve } from "node:path";
import { RUNTIME_DESCRIPTORS } from "../noj-core/src/domains/observability/services/runtime-contract.ts";

export async function checkRuntimeContract(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const prometheusPath = resolve(root, "deploy/monitoring/prometheus.yml");
  const prometheus = await Deno.readTextFile(prometheusPath);
  for (const descriptor of RUNTIME_DESCRIPTORS) {
    if (descriptor.mode === "http") {
      if (!prometheus.includes(descriptor.name)) {
        errors.push(`prometheus.yml 缺少 job: ${descriptor.name}`);
      }
      const fixturePath = resolve(
        root,
        "noj-tests/fixtures/gateway-metrics.txt",
      );
      const fixture = await Deno.readTextFile(fixturePath);
      for (const metric of descriptor.requiredMetrics) {
        if (!fixture.includes(metric)) {
          errors.push(`gateway fixture 缺少指标: ${metric}`);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkRuntimeContract(".");
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    Deno.exit(1);
  }
  console.log("运行时契约检查通过");
}
