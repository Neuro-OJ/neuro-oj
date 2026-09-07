export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpClient {
  get(url: string): Promise<HttpResult>;
  postJson(url: string, body: string): Promise<HttpResult>;
}

const HTTP_TIMEOUT_MS = 5000;

function fetchSignal(): AbortSignal {
  return AbortSignal.timeout(HTTP_TIMEOUT_MS);
}

export function realHttp(): HttpClient {
  return {
    async get(url) {
      const res = await fetch(url, { signal: fetchSignal() });
      return { status: res.status, body: await res.text() };
    },
    async postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: fetchSignal(),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
