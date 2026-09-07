import type { HttpClient } from "./http.ts";

export interface ObservabilityCheckOptions {
  baseUrl?: string;
  checkNotifications?: boolean;
  alertmanagerUrl?: string;
  http?: HttpClient;
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ObservabilityReport {
  items: CheckItem[];
  pass: boolean;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

async function checkEndpoint(
  http: HttpClient,
  name: string,
  url: string,
  expected: string,
): Promise<CheckItem> {
  try {
    const res = await http.get(url);
    const ok = res.status === 200 && res.body.includes(expected);
    return {
      name,
      ok,
      detail: ok
        ? `${url} 正常`
        : `${url} 返回 ${res.status} 或缺少 ${expected}`,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `${url} 访问失败: ${(e as Error).message}`,
    };
  }
}

export async function observabilityCheck(
  opts: ObservabilityCheckOptions = {},
): Promise<ObservabilityReport> {
  const http = opts.http ?? (await import("./http.ts")).realHttp();
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const items: CheckItem[] = [];
  items.push(
    await checkEndpoint(
      http,
      "liveness",
      `${baseUrl}/health/live`,
      '"status":"alive"',
    ),
  );
  items.push(
    await checkEndpoint(
      http,
      "readiness",
      `${baseUrl}/health/ready`,
      '"status":"ready"',
    ),
  );

  const metrics = await http.get(`${baseUrl}/metrics`);
  const metricsOk = metrics.status === 200 &&
    metrics.body.includes("noj_database_up") &&
    metrics.body.includes("noj_judge_workers");
  items.push({
    name: "metrics",
    ok: metricsOk,
    detail: metricsOk
      ? "metrics 包含关键指标"
      : "metrics 缺少 noj_database_up 或 noj_judge_workers",
  });

  if (opts.checkNotifications) {
    if (!opts.alertmanagerUrl) {
      items.push({
        name: "notifications",
        ok: false,
        detail: "checkNotifications 需要 ALERTMANAGER_URL",
      });
    } else {
      const amRes = await http.get(`${opts.alertmanagerUrl}/-/ready`);
      const amOk = amRes.status === 200;
      items.push({
        name: "notifications",
        ok: amOk,
        detail: amOk
          ? `${opts.alertmanagerUrl} 就绪`
          : `${opts.alertmanagerUrl} 返回 ${amRes.status}`,
      });
    }
  }

  return { items, pass: items.every((i) => i.ok) };
}
