/**
 * 探针与 Snapshot Provider 执行器。
 *
 * 所有探针/provider 独立超时、独立 catch；失败降级为 unknown/部分数据。
 * 生产路径带 single-flight + 短 TTL 缓存，避免 /health 与 /metrics 同时触发重复检查。
 */

import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";

export interface ProbeRunResult {
  name: string;
  status: "up" | "down" | "unknown";
  latency_ms: number;
  error?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

interface CacheEntry<T> {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
}

const healthCache = new WeakMap<
  ObservabilityRegistry,
  CacheEntry<ProbeRunResult[]>
>();
const snapshotCache = new WeakMap<
  ObservabilityRegistry,
  CacheEntry<Record<string, unknown>>
>();

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

async function runHealthProbesUncached(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number },
): Promise<ProbeRunResult[]> {
  const probes = registry.listHealthProbes();
  const timeoutMs = opts.timeoutMs ??
    envInt("OBSERVABILITY_SNAPSHOT_TIMEOUT_MS", 1000);
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

export async function runHealthProbes(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeRunResult[]> {
  const ttlMs = envInt("OBSERVABILITY_CACHE_TTL_MS", 1000);
  // 显式传 timeout 的调用（测试/诊断）跳过缓存，避免污染。
  if (opts.timeoutMs !== undefined || ttlMs <= 0) {
    return await runHealthProbesUncached(registry, opts);
  }
  const now = Date.now();
  const cached = healthCache.get(registry);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = runHealthProbesUncached(registry, opts).then((value) => {
    healthCache.set(registry, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }).catch((err) => {
    healthCache.delete(registry);
    throw err;
  });
  healthCache.set(registry, { expiresAt: 0, promise });
  return await promise;
}

function deepMerge(target: Record<string, unknown>, source: unknown): void {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (
      const [key, value] of Object.entries(source as Record<string, unknown>)
    ) {
      // 防止原型污染：忽略危险键。
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
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

async function collectSnapshotUncached(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const providers = registry.listSnapshotProviders();
  const timeoutMs = opts.timeoutMs ??
    envInt("OBSERVABILITY_SNAPSHOT_TIMEOUT_MS", 500);
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
      const message = err instanceof Error ? err.message : String(err);
      providerStatus.push({
        name: provider.name,
        status: message === "timeout" ? "timeout" : "error",
        duration_ms: Math.round(performance.now() - started),
        error: message,
      });
    }
  }));
  out.providers = providerStatus;
  return out;
}

export async function collectSnapshot(
  registry: ObservabilityRegistry,
  opts: { timeoutMs?: number; cacheTtlMs?: number } = {},
): Promise<Record<string, unknown>> {
  const ttlMs = opts.cacheTtlMs ??
    envInt("OBSERVABILITY_CACHE_TTL_MS", 1000);
  if (opts.timeoutMs !== undefined || ttlMs <= 0) {
    return await collectSnapshotUncached(registry, opts);
  }
  const now = Date.now();
  const cached = snapshotCache.get(registry);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = collectSnapshotUncached(registry, opts).then((value) => {
    snapshotCache.set(registry, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }).catch((err) => {
    snapshotCache.delete(registry);
    throw err;
  });
  snapshotCache.set(registry, { expiresAt: 0, promise });
  return await promise;
}
