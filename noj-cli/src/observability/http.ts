export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpClient {
  get(url: string): Promise<HttpResult>;
  postJson(url: string, body: string): Promise<HttpResult>;
}

export function realHttp(): HttpClient {
  return {
    async get(url) {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    },
    async postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
