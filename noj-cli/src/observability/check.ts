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

async function checkGet(
  http: HttpClient,
  name: string,
  url: string,
  predicate: (body: string) => boolean,
): Promise<CheckItem> {
  try {
    const res = await http.get(url);
    const ok = res.status === 200 && predicate(res.body);
    return {
      name,
      ok,
      detail: ok ? `${url} 正常` : `${url} 返回 ${res.status} 或未满足条件`,
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
  const baseUrl = opts.baseUrl ?? Deno.env.get("NOJ_OBSERVABILITY_BASE_URL") ??
    DEFAULT_BASE_URL;
  const items: CheckItem[] = [];
  items.push(
    await checkGet(
      http,
      "liveness",
      `${baseUrl}/health/live`,
      (body) => body.includes('"status":"alive"'),
    ),
  );
  items.push(
    await checkGet(
      http,
      "readiness",
      `${baseUrl}/health/ready`,
      (body) => body.includes('"status":"ready"'),
    ),
  );

  items.push(
    await checkGet(
      http,
      "metrics",
      `${baseUrl}/metrics`,
      (body) =>
        /^noj_database_up\s/m.test(body) && /^noj_judge_workers\s/m.test(body),
    ),
  );

  if (opts.checkNotifications) {
    const alertmanagerUrl = opts.alertmanagerUrl ??
      Deno.env.get("ALERTMANAGER_URL");
    if (!alertmanagerUrl) {
      items.push({
        name: "notifications",
        ok: false,
        detail: "checkNotifications 需要 ALERTMANAGER_URL",
      });
    } else {
      items.push(
        await checkGet(
          http,
          "notifications",
          `${alertmanagerUrl}/-/ready`,
          () => true,
        ),
      );
    }
  }

  return { items, pass: items.every((i) => i.ok) };
}
