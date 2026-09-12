import * as http from "node:http";
import * as https from "node:https";
import type {
  CreatedSubmission,
  Problem,
  SubmissionDetail,
  User,
} from "./types";

export interface HttpRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

interface ErrorEnvelope {
  error?:
    | string
    | {
        code?: string;
        message?: string;
        details?: unknown;
      };
  code?: string;
  message?: string;
  request_id?: string;
}

/** 带服务端错误码和请求编号的 API 异常。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 校验并规范化用户配置的网站地址。 */
export function normalizeServerUrl(value: string): string {
  const input = value.trim();
  if (!input) {
    throw new Error("请先配置 Neuro OJ 网站地址");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Neuro OJ 网站地址格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Neuro OJ 网站地址只支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Neuro OJ 网站地址不能包含账号或密码");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/** 使用 Node 内置 HTTP 客户端，兼容不提供全局 fetch 的旧版 VS Code。 */
export const nodeHttpTransport: HttpTransport = (request) =>
  new Promise((resolve, reject) => {
    const client = request.url.protocol === "https:" ? https : http;
    const req = client.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error("Neuro OJ 响应超过 2 MiB 限制"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          });
        });
      },
    );
    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new Error("连接 Neuro OJ 超时"));
    });
    req.on("error", reject);
    if (request.body) req.write(request.body);
    req.end();
  });

/** Neuro OJ 公开 REST API 客户端。 */
export class NeuroOjApi {
  private token: string | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly timeoutMs: number,
    private readonly transport: HttpTransport = nodeHttpTransport,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token?.trim() || undefined;
  }

  async login(
    login: string,
    password: string,
    code?: string,
  ): Promise<{
    user: User;
    token: string;
  }> {
    const response = await this.request<{
      data: { user: User; token: string };
    }>("/api/v1/auth/login", {
      method: "POST",
      body: { login, password, ...(code ? { code } : {}) },
      authenticated: false,
    });
    return response.data;
  }

  async currentUser(): Promise<User> {
    const response = await this.request<{ data: User }>("/api/v1/auth/me");
    return response.data;
  }

  async logout(): Promise<void> {
    await this.request("/api/v1/auth/logout", { method: "POST" });
  }

  /** 通过公开题目端点验证服务器地址，无需登录或发送已有令牌。 */
  async checkConnection(): Promise<void> {
    await this.request("/api/v1/problems?page=1&limit=1&type=P", {
      authenticated: false,
    });
  }

  async listProblems(): Promise<Problem[]> {
    const items: Problem[] = [];
    let page = 1;
    let total = Number.POSITIVE_INFINITY;

    while (items.length < total) {
      const response = await this.request<{
        data: Problem[];
        total: number;
      }>(`/api/v1/problems?page=${page}&limit=100&type=P`);
      items.push(...response.data);
      total = response.total;
      if (response.data.length === 0) break;
      page += 1;
    }

    return items.filter(
      (problem) => !problem.is_objective && problem.submission_mode === "code",
    );
  }

  async submitCode(
    problemId: string,
    code: string,
    fileName: string,
  ): Promise<CreatedSubmission> {
    const response = await this.request<{ data: CreatedSubmission }>(
      "/api/v1/submissions",
      {
        method: "POST",
        body: {
          problem_id: problemId,
          language: "python3",
          code,
          file_name: fileName,
        },
      },
    );
    return response.data;
  }

  async submission(id: string): Promise<SubmissionDetail> {
    const response = await this.request<{ data: SubmissionDetail }>(
      `/api/v1/submissions/${encodeURIComponent(id)}`,
    );
    return response.data;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated !== false;
    if (authenticated && !this.token) {
      throw new ApiError("请先登录 Neuro OJ", 401, "AUTH_REQUIRED");
    }

    const body = options.body ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body) headers["Content-Type"] = "application/json";
    if (authenticated && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await this.transport({
      url: new URL(path, `${normalizeServerUrl(this.serverUrl)}/`),
      method: options.method ?? "GET",
      headers,
      body,
      timeoutMs: this.timeoutMs,
    });

    let payload: unknown = undefined;
    if (response.body) {
      try {
        payload = JSON.parse(response.body);
      } catch {
        if (response.status >= 200 && response.status < 300) {
          throw new ApiError("Neuro OJ 返回了无法解析的响应", response.status);
        }
      }
    }

    if (response.status < 200 || response.status >= 300) {
      const error = (payload ?? {}) as ErrorEnvelope;
      const nestedError =
        typeof error.error === "object" ? error.error : undefined;
      throw new ApiError(
        nestedError?.message ??
          (typeof error.error === "string" ? error.error : undefined) ??
          error.message ??
          `请求失败（HTTP ${response.status}）`,
        response.status,
        nestedError?.code ?? error.code,
        error.request_id,
      );
    }

    return payload as T;
  }
}
