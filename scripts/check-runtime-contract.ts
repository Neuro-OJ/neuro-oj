/**
 * 外部运行时契约检查。
 *
 * 校验：
 * - HTTP 模式运行时的 Prometheus job、gateway 实际路由与契约指标；
 * - heartbeat 模式运行时的 core 侧平台指标定义齐全。
 */

import { resolve } from "node:path";
import { RUNTIME_DESCRIPTORS } from "../noj-core/src/domains/observability/services/runtime-contract.ts";

export async function checkRuntimeContract(root = "."): Promise<string[]> {
  const errors: string[] = [];
  const prometheusPath = resolve(root, "deploy/monitoring/prometheus.yml");
  let prometheus = "";
  try {
    prometheus = await Deno.readTextFile(prometheusPath);
  } catch {
    // 与其他检查器保持一致：缺失文件返回错误而非抛出，保证调用方拿到可读诊断。
    errors.push("prometheus.yml 不存在");
  }
  const gatewayApp = await Deno.readTextFile(
    resolve(root, "noj-llm-gateway/src/app.ts"),
  ).catch(() => "");
  const gatewayMetrics = await Deno.readTextFile(
    resolve(root, "noj-llm-gateway/src/metrics.ts"),
  ).catch(() => "");
  const corePlatform = await Deno.readTextFile(
    resolve(root, "noj-core/src/domains/observability/metrics/platform.ts"),
  ).catch(() => "");

  for (const descriptor of RUNTIME_DESCRIPTORS) {
    if (descriptor.mode === "http") {
      if (!prometheus.includes(descriptor.name)) {
        errors.push(`prometheus.yml 缺少 job: ${descriptor.name}`);
      }
      if (descriptor.name === "noj-llm-gateway") {
        if (descriptor.healthUrl && !gatewayApp.includes('"/health/live"')) {
          errors.push(`gateway 缺少健康端点: ${descriptor.healthUrl}`);
        }
        if (descriptor.metricsUrl && !gatewayApp.includes('"/metrics"')) {
          errors.push(`gateway 缺少指标端点: ${descriptor.metricsUrl}`);
        }
        for (const metric of descriptor.requiredMetrics) {
          if (!gatewayMetrics.includes(metric)) {
            errors.push(`gateway 指标未实现: ${metric}`);
          }
        }
      }
    } else if (descriptor.mode === "heartbeat") {
      for (const metric of descriptor.requiredMetrics) {
        if (!corePlatform.includes(metric)) {
          errors.push(`core 平台指标未定义: ${metric}`);
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
