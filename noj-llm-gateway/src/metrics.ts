/**
 * noj-llm-gateway 轻量进程内 Prometheus 指标。
 *
 * 仅保留运行时契约要求的低基数指标；不引入业务标识符作为标签。
 */

type Labels = Readonly<Record<string, string>>;

interface HistogramValue {
  sum: number;
  count: number;
  buckets: number[];
  counts: number[];
}

const DEFAULT_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

const counters = new Map<string, Map<string, number>>();
const histograms = new Map<string, Map<string, HistogramValue>>();

const META: Record<
  string,
  { help: string; type: "counter" | "histogram" }
> = {
  noj_llm_requests_total: { help: "LLM 请求总数", type: "counter" },
  noj_llm_request_duration_seconds: {
    help: "LLM 请求耗时（秒）",
    type: "histogram",
  },
  noj_llm_tokens_total: {
    help: "LLM token 用量（按计费口径）",
    type: "counter",
  },
  noj_llm_rate_limited_total: { help: "LLM 限流总数", type: "counter" },
  noj_llm_quota_exhausted_total: { help: "LLM 额度耗尽总数", type: "counter" },
  noj_llm_provider_errors_total: {
    help: "LLM provider 错误总数",
    type: "counter",
  },
};

function labelsKey(labels: Labels = {}): string {
  const entries = Object.entries(labels)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function parseKey(key: string): [string, string][] {
  return JSON.parse(key) as [string, string][];
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

/** 计数器自增；未知指标/类型不匹配时 no-op。 */
export function inc(name: string, labels: Labels = {}, amount = 1): void {
  if (!META[name] || META[name].type !== "counter") return;
  const key = labelsKey(labels);
  const series = counters.get(name) ?? new Map<string, number>();
  series.set(
    key,
    (series.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0),
  );
  counters.set(name, series);
}

/** 观察一次 histogram 样本。 */
export function observe(
  name: string,
  value: number,
  labels: Labels = {},
): void {
  if (!META[name] || META[name].type !== "histogram") return;
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const key = labelsKey(labels);
  const series = histograms.get(name) ?? new Map<string, HistogramValue>();
  const current = series.get(key) ?? {
    sum: 0,
    count: 0,
    buckets: [...DEFAULT_BUCKETS],
    counts: DEFAULT_BUCKETS.map(() => 0),
  };
  current.sum += safe;
  current.count += 1;
  current.counts = current.buckets.map((bucket, index) =>
    safe <= bucket
      ? (current.counts[index] ?? 0) + 1
      : (current.counts[index] ?? 0)
  );
  series.set(key, current);
  histograms.set(name, series);
}

/** 渲染 Prometheus 文本（无样本的 counter 输出 0）。 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of Object.keys(META).sort()) {
    const meta = META[name];
    if (!meta) continue;
    lines.push(`# HELP ${name} ${meta.help}`);
    lines.push(`# TYPE ${name} ${meta.type}`);
    if (meta.type === "counter") {
      const series = counters.get(name) ?? new Map<string, number>();
      for (
        const [key, value] of [...series.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        )
      ) {
        lines.push(`${name}${renderLabels(parseKey(key))} ${value}`);
      }
      if (series.size === 0) lines.push(`${name} 0`);
      continue;
    }
    const series = histograms.get(name) ?? new Map<string, HistogramValue>();
    for (
      const [key, value] of [...series.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )
    ) {
      const labels = parseKey(key);
      value.buckets.forEach((bucket, index) => {
        lines.push(
          `${name}_bucket${renderLabels([...labels, ["le", String(bucket)]])} ${
            value.counts[index] ?? 0
          }`,
        );
      });
      lines.push(
        `${name}_bucket${
          renderLabels([...labels, ["le", "+Inf"]])
        } ${value.count}`,
      );
      lines.push(`${name}_sum${renderLabels(labels)} ${value.sum}`);
      lines.push(`${name}_count${renderLabels(labels)} ${value.count}`);
    }
    if (series.size === 0) {
      for (const bucket of DEFAULT_BUCKETS) {
        lines.push(`${name}_bucket{le="${bucket}"} 0`);
      }
      lines.push(`${name}_bucket{le="+Inf"} 0`);
      lines.push(`${name}_sum 0`);
      lines.push(`${name}_count 0`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
