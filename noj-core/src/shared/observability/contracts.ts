/**
 * 可观测性低层 kernel 契约。
 *
 * 零业务依赖，供 shared/** 与所有 domain 使用。
 * 写侧实现见 registry.ts；读侧聚合见 domains/observability。
 */

export type MetricType = "counter" | "gauge" | "histogram";
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  owner: string;
  labels?: readonly string[];
  buckets?: readonly number[];
}

export interface MetricSink {
  define(def: MetricDefinition): void;
  inc(name: string, labels?: MetricLabels, amount?: number): void;
  set(name: string, value: number, labels?: MetricLabels): void;
  add(name: string, amount: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export interface HealthProbeResult {
  status: "up" | "down" | "unknown";
  latency_ms?: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface HealthProbe {
  name: string;
  critical: boolean;
  timeoutMs?: number;
  check(): Promise<HealthProbeResult> | HealthProbeResult;
}

export interface SnapshotProvider<T = unknown> {
  name: string;
  timeoutMs?: number;
  collect(): Promise<T>;
}

export interface ObservabilityRegistry extends MetricSink {
  registerHealthProbe(probe: HealthProbe): void;
  registerSnapshotProvider(provider: SnapshotProvider): void;
  registerBusinessMetric(def: MetricDefinition): void;
  listHealthProbes(): HealthProbe[];
  listSnapshotProviders(): SnapshotProvider[];
  render(): string;
}
