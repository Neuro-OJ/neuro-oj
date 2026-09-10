/**
 * 探针与 Snapshot Provider 执行器。
 *
 * 所有探针/provider 独立超时、独立 catch；失败降级为 unknown/部分数据。
 */

import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";

export interface ProbeRunResult {
  name: string;
  status: "up" | "down" | "unknown";
  latency_ms: number;
  error?: string;
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runHealthProbes(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeRunResult[]> {
  const probes = registry.listHealthProbes();
  const timeoutMs = opts.timeoutMs ?? 1000;
  const results: ProbeRunResult[] = [];
  await Promise.all(probes.map(async (probe) => {
    const started = performance.now();
    try {
      const result = await withTimeout(
        () => Promise.resolve(probe.check()),
        probe.timeoutMs ?? timeoutMs,
      );
      results.push({
        name: probe.name,
        status: result.status,
        latency_ms: Math.round(performance.now() - started),
        error: result.error,
      });
    } catch (err) {
      results.push({
        name: probe.name,
        status: "unknown",
        latency_ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function deepMerge(target: Record<string, unknown>, source: unknown): void {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (
      const [key, value] of Object.entries(source as Record<string, unknown>)
    ) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        target[key] && typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        deepMerge(target[key] as Record<string, unknown>, value);
      } else {
        target[key] = value;
      }
    }
  }
}

export async function collectSnapshot(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number; cacheTtlMs?: number } = {},
): Promise<Record<string, unknown>> {
  const providers = registry.listSnapshotProviders();
  const timeoutMs = opts.timeoutMs ?? 500;
  const out: Record<string, unknown> = {};
  const providerStatus: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[] = [];
  await Promise.all(providers.map(async (provider) => {
    const started = performance.now();
    try {
      const contribution = await withTimeout(
        () => Promise.resolve(provider.collect()),
        provider.timeoutMs ?? timeoutMs,
      );
      deepMerge(out, contribution);
      providerStatus.push({
        name: provider.name,
        status: "ok",
        duration_ms: Math.round(performance.now() - started),
      });
    } catch (err) {
      providerStatus.push({
        name: provider.name,
        status: "timeout",
        duration_ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  out.providers = providerStatus;
  return out;
}
