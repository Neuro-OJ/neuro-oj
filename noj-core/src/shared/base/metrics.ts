/**
 * 进程内低基数指标注册表。
 *
 * 仅保存 Prometheus 需要的聚合值，不接受用户、题目、提交等动态标识符作为标签。
 * 进程重启后指标归零，长期趋势由 Prometheus 负责保存。
 */

export type MetricLabels = Record<string, string | number | boolean>;

interface MetricDefinition {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  buckets: number[];
  values: Map<string, MetricValue>;
}

interface CounterValue {
  kind: "counter";
  value: number;
}

interface GaugeValue {
  kind: "gauge";
  value: number;
}

interface HistogramValue {
  kind: "histogram";
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

type MetricValue = CounterValue | GaugeValue | HistogramValue;

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
  return `{${
    labels.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")
  }}`;
}

function finiteValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** 低基数指标注册表。 */
export class MetricsRegistry {
  private definitions = new Map<string, MetricDefinition>();

  /** 注册指标；重复注册同名同类型指标是幂等的。 */
  define(
    name: string,
    help: string,
    type: MetricDefinition["type"],
    buckets = DEFAULT_HISTOGRAM_BUCKETS,
  ): void {
    const existing = this.definitions.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`指标类型冲突: ${name}`);
      }
      return;
    }
    this.definitions.set(name, {
      name,
      help,
      type,
      buckets: type === "histogram" ? [...buckets].sort((a, b) => a - b) : [],
      values: new Map(),
    });
  }

  /** Counter 增量。 */
  inc(name: string, labels: MetricLabels = {}, amount = 1): void {
    const definition = this.require(name, "counter");
    const key = labelsKey(labels);
    const current = definition.values.get(key) as CounterValue | undefined;
    if (current) {
      current.value += finiteValue(amount);
      return;
    }
    definition.values.set(key, {
      kind: "counter",
      value: finiteValue(amount),
    });
  }

  /** Gauge 设置。 */
  set(name: string, value: number, labels: MetricLabels = {}): void {
    const definition = this.require(name, "gauge");
    definition.values.set(labelsKey(labels), {
      kind: "gauge",
      value: finiteValue(value),
    });
  }

  /** Gauge 增减。 */
  add(name: string, amount: number, labels: MetricLabels = {}): void {
    const definition = this.require(name, "gauge");
    const key = labelsKey(labels);
    const current = definition.values.get(key) as GaugeValue | undefined;
    if (current) {
      current.value += finiteValue(amount);
      return;
    }
    definition.values.set(key, { kind: "gauge", value: finiteValue(amount) });
  }

  /** Histogram 观察值。 */
  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const definition = this.require(name, "histogram");
    const histogram = definition.values.get(labelsKey(labels)) as
      | HistogramValue
      | undefined;
    const safeValue = Math.max(0, finiteValue(value));
    if (histogram) {
      histogram.sum += safeValue;
      histogram.count += 1;
      for (let i = 0; i < histogram.buckets.length; i++) {
        if (safeValue <= histogram.buckets[i]) histogram.counts[i] += 1;
      }
      return;
    }

    const histogramBuckets = [...definition.buckets];
    definition.values.set(labelsKey(labels), {
      kind: "histogram",
      buckets: histogramBuckets,
      counts: histogramBuckets.map((bucket) => safeValue <= bucket ? 1 : 0),
      sum: safeValue,
      count: 1,
    });
  }

  /** 读取 counter 总和，供管理端快照使用。 */
  sum(name: string): number {
    const definition = this.definitions.get(name);
    if (!definition) return 0;
    return [...definition.values.values()].reduce((total, value) => {
      if (value.kind === "histogram") return total + value.sum;
      return total + value.value;
    }, 0);
  }

  /** 读取 histogram/counter 的样本数量，供管理端计算平均值。 */
  count(name: string): number {
    const definition = this.definitions.get(name);
    if (!definition) return 0;
    return [...definition.values.values()].reduce((total, value) => {
      return total + (value.kind === "histogram" ? value.count : 1);
    }, 0);
  }

  /** 重置全部值；仅测试使用。 */
  reset(): void {
    for (const definition of this.definitions.values()) {
      definition.values.clear();
    }
  }

  /** 输出 Prometheus text exposition 格式。 */
  render(): string {
    const lines: string[] = [];
    for (
      const definition of [...this.definitions.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    ) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      const entries = [...definition.values.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      );
      for (const [key, value] of entries) {
        const labels = JSON.parse(key) as [string, string][];
        const rendered = renderLabels(labels);
        if (value.kind === "histogram") {
          value.buckets.forEach((bucket, index) => {
            lines.push(`${definition.name}_bucket${
              renderLabels([
                ...labels,
                ["le", String(bucket)],
              ])
            } ${value.counts[index]}`);
          });
          lines.push(`${definition.name}_bucket${
            renderLabels([
              ...labels,
              ["le", "+Inf"],
            ])
          } ${value.count}`);
          lines.push(`${definition.name}_sum${rendered} ${value.sum}`);
          lines.push(`${definition.name}_count${rendered} ${value.count}`);
        } else {
          lines.push(`${definition.name}${rendered} ${value.value}`);
        }
      }
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  private require(
    name: string,
    type: MetricDefinition["type"],
  ): MetricDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`指标未定义: ${name}`);
    if (definition.type !== type) throw new Error(`指标类型不匹配: ${name}`);
    return definition;
  }
}

export const metrics = new MetricsRegistry();

metrics.define("noj_http_requests_total", "HTTP 请求总数", "counter");
metrics.define("noj_http_request_errors_total", "HTTP 5xx 请求总数", "counter");
metrics.define("noj_http_rate_limited_total", "HTTP 被限流请求总数", "counter");
metrics.define(
  "noj_http_request_duration_seconds",
  "HTTP 请求耗时（秒）",
  "histogram",
);
metrics.define("noj_evaluation_results_total", "收到的评测结果总数", "counter");
metrics.define(
  "noj_evaluation_consumer_errors_total",
  "评测结果消费者错误总数",
  "counter",
);
metrics.define(
  "noj_database_health_checks_total",
  "PostgreSQL 健康检查总数",
  "counter",
);
metrics.define(
  "noj_database_health_check_errors_total",
  "PostgreSQL 健康检查失败总数",
  "counter",
);
metrics.define(
  "noj_redis_health_checks_total",
  "Redis 健康检查总数",
  "counter",
);
metrics.define(
  "noj_redis_health_check_errors_total",
  "Redis 健康检查失败总数",
  "counter",
);

/**
 * 将请求路径归一化为低基数路由。
 * Hono 能提供模板时优先使用模板；fallback 会隐藏 UUID、数字和长动态片段。
 */
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
