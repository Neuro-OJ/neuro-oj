/**
 * 进程内低基数指标注册表（Fail-open）。
 *
 * 所有写方法内部 try/catch，绝不向业务调用点抛错。
 * 长期趋势由 Prometheus 保存；进程重启后指标归零。
 */

import type {
  HealthProbe,
  MetricDefinition,
  MetricLabels,
  ObservabilityRegistry,
  SnapshotProvider,
} from "./contracts.ts";
import {
  LABEL_WHITELIST,
  MAX_SERIES_PER_METRIC,
  validateLabels,
} from "./labels.ts";

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
];

interface MetricValue {
  kind: "counter" | "gauge" | "histogram";
  value: number;
  buckets?: number[];
  counts?: number[];
  sum?: number;
  count?: number;
}

interface MetricState {
  def: MetricDefinition;
  values: Map<string, MetricValue>;
}

function normalizeLabels(labels: MetricLabels = {}): [string, string][] {
  return Object.entries(labels)
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

function labelsKey(labels: MetricLabels): string {
  return JSON.stringify(normalizeLabels(labels));
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll(
    "\n",
    "\\n",
  );
}

function renderLabels(labels: [string, string][]): string {
  if (labels.length === 0) return "";
  return `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

function finiteValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function createObservabilityRegistry(options: {
  strict?: boolean;
  maxSeriesPerMetric?: number;
} = {}): ObservabilityRegistry {
  const strict = options.strict ?? false;
  const maxSeries = options.maxSeriesPerMetric ?? MAX_SERIES_PER_METRIC;
  const metrics = new Map<string, MetricState>();
  const probes = new Map<string, HealthProbe>();
  const providers = new Map<string, SnapshotProvider>();
  const self = new Map<string, number>();

  function selfInc(name: string): void {
    self.set(name, (self.get(name) ?? 0) + 1);
  }

  function requireState(
    name: string,
    type: MetricDefinition["type"],
  ): MetricState | undefined {
    const state = metrics.get(name);
    if (!state) {
      selfInc("noj_observability_write_errors_total");
      return undefined;
    }
    if (state.def.type !== type) {
      selfInc("noj_observability_write_errors_total");
      return undefined;
    }
    return state;
  }

  function write(
    name: string,
    type: MetricDefinition["type"],
    labels: MetricLabels | undefined,
    mutate: (value: MetricValue) => void,
  ): void {
    try {
      const state = requireState(name, type);
      if (!state) return;
      const errors = validateLabels(name, labels, state.def.labels);
      if (errors.length > 0) {
        selfInc("noj_observability_write_errors_total");
        return;
      }
      const key = labelsKey(labels ?? {});
      if (state.values.size >= maxSeries && !state.values.has(key)) {
        selfInc("noj_observability_metric_dropped_total");
        return;
      }
      const current = state.values.get(key);
      if (current) {
        mutate(current);
      } else {
        const base: MetricValue = type === "histogram"
          ? {
            kind: "histogram",
            value: 0,
            buckets: [...(state.def.buckets ?? DEFAULT_HISTOGRAM_BUCKETS)],
            counts: [],
            sum: 0,
            count: 0,
          }
          : { kind: type, value: 0 };
        mutate(base);
        state.values.set(key, base);
      }
    } catch {
      selfInc("noj_observability_write_errors_total");
    }
  }

  const registry: ObservabilityRegistry = {
    define(def: MetricDefinition): void {
      const existing = metrics.get(def.name);
      if (existing) {
        if (existing.def.type !== def.type) {
          if (strict) throw new Error(`指标类型冲突: ${def.name}`);
          selfInc("noj_observability_write_errors_total");
        }
        return;
      }
      metrics.set(def.name, { def, values: new Map() });
    },

    inc(name: string, labels?: MetricLabels, amount = 1): void {
      write(name, "counter", labels, (v) => {
        v.value += finiteValue(amount);
      });
    },

    set(name: string, value: number, labels?: MetricLabels): void {
      write(name, "gauge", labels, (v) => {
        v.value = finiteValue(value);
      });
    },

    add(name: string, amount: number, labels?: MetricLabels): void {
      write(name, "gauge", labels, (v) => {
        v.value += finiteValue(amount);
      });
    },

    observe(name: string, value: number, labels?: MetricLabels): void {
      write(name, "histogram", labels, (v) => {
        const safe = Math.max(0, finiteValue(value));
        v.sum = (v.sum ?? 0) + safe;
        v.count = (v.count ?? 0) + 1;
        const buckets = v.buckets ?? [];
        const counts = v.counts ?? [];
        for (let i = 0; i < buckets.length; i++) {
          if (safe <= buckets[i]!) counts[i] = (counts[i] ?? 0) + 1;
        }
        v.counts = counts;
      });
    },

    registerHealthProbe(probe: HealthProbe): void {
      probes.set(probe.name, probe);
    },

    registerSnapshotProvider(provider: SnapshotProvider): void {
      providers.set(provider.name, provider);
    },

    registerBusinessMetric(def: MetricDefinition): void {
      const errors = validateMetricDefinition(def);
      if (errors.length > 0) {
        if (strict) throw new Error(errors.join("; "));
        selfInc("noj_observability_write_errors_total");
        return;
      }
      registry.define(def);
    },

    listHealthProbes(): HealthProbe[] {
      return [...probes.values()];
    },

    listSnapshotProviders(): SnapshotProvider[] {
      return [...providers.values()];
    },

    sum(name: string): number {
      const state = metrics.get(name);
      let total = 0;
      if (state) {
        for (const v of state.values.values()) {
          total += v.kind === "histogram" ? (v.sum ?? 0) : v.value;
        }
      }
      total += self.get(name) ?? 0;
      return total;
    },

    count(name: string): number {
      const state = metrics.get(name);
      if (!state) return 0;
      let total = 0;
      for (const v of state.values.values()) {
        total += v.kind === "histogram" ? (v.count ?? 0) : 1;
      }
      return total;
    },

    render(): string {
      const lines: string[] = [];
      for (
        const [name, state] of [...metrics.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        )
      ) {
        lines.push(`# HELP ${name} ${state.def.help}`);
        lines.push(`# TYPE ${name} ${state.def.type}`);
        for (
          const [key, v] of [...state.values.entries()].sort(([a], [b]) =>
            a.localeCompare(b)
          )
        ) {
          const labels = JSON.parse(key) as [string, string][];
          const rendered = renderLabels(labels);
          if (v.kind === "histogram") {
            const buckets = v.buckets ?? [];
            const counts = v.counts ?? [];
            buckets.forEach((bucket, i) => {
              lines.push(
                `${name}_bucket${
                  renderLabels([...labels, ["le", String(bucket)]])
                } ${counts[i] ?? 0}`,
              );
            });
            lines.push(
              `${name}_bucket${renderLabels([...labels, ["le", "+Inf"]])} ${
                v.count ?? 0
              }`,
            );
            lines.push(`${name}_sum${rendered} ${v.sum ?? 0}`);
            lines.push(`${name}_count${rendered} ${v.count ?? 0}`);
          } else {
            lines.push(`${name}${rendered} ${v.value}`);
          }
        }
      }
      for (
        const [name, value] of [...self.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        )
      ) {
        lines.push(`# HELP ${name} 观测自身错误计数`);
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${value}`);
      }
      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    },
  };

  return registry;
}

function envMaxSeries(): number {
  const raw = Deno.env.get("OBSERVABILITY_MAX_SERIES");
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : MAX_SERIES_PER_METRIC;
}

export const observability = createObservabilityRegistry({
  maxSeriesPerMetric: envMaxSeries(),
});

export function validateMetricDefinition(def: MetricDefinition): string[] {
  const errors: string[] = [];
  if (!/^noj_[a-z][a-z0-9_]*$/.test(def.name)) {
    errors.push("指标名必须以 noj_ 开头且只含小写字母/数字/下划线");
  }
  if (!def.help) errors.push("help 必填");
  if (!def.owner) errors.push("owner 必填");
  if (def.labels) {
    for (const label of def.labels) {
      if (
        !LABEL_WHITELIST.includes(label as (typeof LABEL_WHITELIST)[number])
      ) {
        errors.push(`标签不在白名单: ${label}`);
      }
    }
  }
  return errors;
}

export function normalizeMetricRoute(path: string, routePath?: string): string {
  if (routePath && routePath.includes(":")) return routePath;
  return path.split("/").map((segment) => {
    if (!segment) return segment;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
    if (/^\d+$/.test(segment)) return ":id";
    if (segment.length > 48) return ":param";
    return segment;
  }).join("/") || "/";
}
