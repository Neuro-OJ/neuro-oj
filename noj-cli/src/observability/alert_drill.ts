import type { HttpClient } from "./http.ts";

export interface AlertDrillOptions {
  alertmanagerUrl?: string;
  holdSeconds?: number;
  http?: HttpClient;
}

export interface AlertDrillReport {
  injected: boolean;
  resolved: boolean;
  holdSeconds: number;
}

const DEFAULT_ALERTMANAGER_URL = "http://alertmanager:9093";

function activePayload(startsAt: string): string {
  return JSON.stringify([
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "critical",
        instance: "notification-drill",
      },
      annotations: {
        summary: "告警投递演练（critical）",
        description: `投递演练测试告警，无需处理；startsAt=${startsAt}`,
      },
      startsAt,
    },
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "warning",
        instance: "notification-drill",
      },
      annotations: {
        summary: "告警投递演练（warning）",
        description: `投递演练测试告警，无需处理；startsAt=${startsAt}`,
      },
      startsAt,
    },
  ]);
}

function resolvedPayload(startsAt: string, endsAt: string): string {
  return JSON.stringify([
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "critical",
        instance: "notification-drill",
      },
      annotations: { summary: "告警投递演练（critical）已恢复" },
      startsAt,
      endsAt,
    },
    {
      labels: {
        alertname: "NojNotificationDrill",
        severity: "warning",
        instance: "notification-drill",
      },
      annotations: { summary: "告警投递演练（warning）已恢复" },
      startsAt,
      endsAt,
    },
  ]);
}

async function resolveAlerts(
  http: HttpClient,
  url: string,
  payload: string,
): Promise<void> {
  let lastError: unknown = new Error("未知错误");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await http.postJson(url, payload);
      if (res.status === 200) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  const detail = lastError instanceof Error
    ? lastError.message
    : String(lastError);
  throw new Error(
    `恢复告警失败：${detail}。告警 NojNotificationDrill 可能仍处于活跃状态，请手动清理 Alertmanager。`,
  );
}

export async function alertDrill(
  opts: AlertDrillOptions = {},
): Promise<AlertDrillReport> {
  const http = opts.http ?? (await import("./http.ts")).realHttp();
  const alertmanagerUrl = opts.alertmanagerUrl ??
    Deno.env.get("ALERTMANAGER_URL") ?? DEFAULT_ALERTMANAGER_URL;
  const holdSeconds = opts.holdSeconds ?? 300;
  const startsAt = new Date().toISOString();
  const url = `${alertmanagerUrl}/api/v2/alerts`;

  const active = await http.postJson(url, activePayload(startsAt));
  if (active.status !== 200) {
    throw new Error(`注入告警失败：HTTP ${active.status}`);
  }

  if (holdSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
  }

  await resolveAlerts(
    http,
    url,
    resolvedPayload(startsAt, new Date().toISOString()),
  );

  return { injected: true, resolved: true, holdSeconds };
}
