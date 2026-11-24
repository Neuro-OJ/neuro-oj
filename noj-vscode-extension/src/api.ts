import * as http from "node:http";
import * as https from "node:https";
import type {
  CreatedSubmission,
  Domain,
  DomainProblem,
  DomainProblemDetail,
  Problem,
  SelfTestCaseInput,
  SelfTestCreated,
  SelfTestDetail,
  SubmissionDetail,
  User,
} from "./types";

export interface HttpRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
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

/** 构造标准 `multipart/form-data` 请求体（表单字段排在文件前，满足流式解析）。 */
export function buildMultipartFormData(
  fields: Record<string, string>,
  file: {
    fieldName: string;
    fileName: string;
    contentType: string;
    data: Buffer;
  },
): { contentType: string; body: Buffer } {
  const boundary = `----NeuroOjBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const sanitizeHeaderValue = (raw: string) => raw.replace(/[\r\n"]/g, "_");

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeHeaderValue(name)}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeHeaderValue(file.fieldName)}"; filename="${sanitizeHeaderValue(file.fileName)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
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
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error("Neuro OJ 响应超过 4 MiB 限制"));
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

  /** 通过公开站点端点验证服务器地址，无需登录或发送已有令牌。 */
  async checkConnection(): Promise<void> {
    await this.request("/api/v1/instance", {
      authenticated: false,
    });
  }

  async domains(): Promise<Domain[]> {
    return (await this.request<{ data: Domain[] }>("/api/v1/me/domains")).data;
  }

  async domainProblems(slug: string): Promise<Problem[]> {
    const items: Problem[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{
        items: DomainProblem[];
        total: number;
      }>(
        `/api/v1/domains/${encodeURIComponent(
          slug,
        )}/problems?page=${page}&limit=100`,
      );
      for (const problem of result.items) {
        if (problem.kind === "objective") continue;
        if (problem.submission_mode === "ui") continue;
        items.push({
          id: problem.reference.display_ref,
          display_id: problem.reference.display_ref,
          title: problem.title,
          difficulty: "",
          is_objective: false,
          submission_mode:
            problem.submission_mode === "artifact" ||
            problem.submission_mode === "prediction"
              ? problem.submission_mode
              : "code",
        });
      }
      if (page * 100 >= result.total || result.items.length === 0) return items;
    }
  }

  async domainProblem(
    slug: string,
    reference: string,
  ): Promise<DomainProblemDetail> {
    return await this.request<DomainProblemDetail>(
      `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(
        reference,
      )}`,
    );
  }

  async submitDomainCode(
    slug: string,
    reference: string,
    code: string,
    fileName: string,
    versionId: string,
  ): Promise<CreatedSubmission> {
    return (
      await this.request<{ data: CreatedSubmission }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/submissions`,
        {
          method: "POST",
          body: {
            problem_ref: reference,
            language: "python3",
            code,
            file_name: fileName,
            version_id: versionId,
          },
        },
      )
    ).data;
  }

  /** 提交多文件 ZIP 产物（multipart/form-data）。 */
  async submitDomainArtifact(
    slug: string,
    reference: string,
    zipBuffer: Buffer,
    fileName: string,
    versionId: string,
  ): Promise<CreatedSubmission> {
    return await this.submitDomainMultipart(
      slug,
      reference,
      zipBuffer,
      fileName,
      versionId,
      "application/zip",
    );
  }

  /** 提交单文件预测结果（prediction 模式，multipart/form-data）。 */
  async submitDomainPrediction(
    slug: string,
    reference: string,
    fileBuffer: Buffer,
    fileName: string,
    versionId: string,
  ): Promise<CreatedSubmission> {
    return await this.submitDomainMultipart(
      slug,
      reference,
      fileBuffer,
      fileName,
      versionId,
      "application/octet-stream",
    );
  }

  private async submitDomainMultipart(
    slug: string,
    reference: string,
    fileBuffer: Buffer,
    fileName: string,
    versionId: string,
    contentType: string,
  ): Promise<CreatedSubmission> {
    const multipart = buildMultipartFormData(
      {
        problem_ref: reference,
        version_id: versionId,
      },
      {
        fieldName: "file",
        fileName,
        contentType,
        data: fileBuffer,
      },
    );
    return (
      await this.requestRaw<{ data: CreatedSubmission }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/submissions`,
        {
          method: "POST",
          headers: {
            "Content-Type": multipart.contentType,
            "Content-Length": String(multipart.body.length),
          },
          body: multipart.body,
        },
      )
    ).data;
  }

  async domainSubmission(slug: string, id: string): Promise<SubmissionDetail> {
    return (
      await this.request<{ data: SubmissionDetail }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(
          id,
        )}`,
      )
    ).data;
  }

  /** 读取提交结构化反馈；若后端尚未开启该接口（404）返回 `null` 以便优雅回退。 */
  async domainSubmissionFeedback(
    slug: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    return await this.requestOptionalFeedback(
      `/api/v1/domains/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(
        id,
      )}/feedback`,
    );
  }

  /** 发起云端自测。 */
  async createDomainSelfTest(
    slug: string,
    reference: string,
    input: {
      code: string;
      language?: string;
      file_name?: string;
      version_id?: string;
      cases?: SelfTestCaseInput[];
    },
  ): Promise<SelfTestCreated> {
    return (
      await this.request<{ data: SelfTestCreated }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(
          reference,
        )}/self-tests`,
        {
          method: "POST",
          body: {
            code: input.code,
            language: input.language ?? "python3",
            ...(input.file_name ? { file_name: input.file_name } : {}),
            ...(input.version_id ? { version_id: input.version_id } : {}),
            ...(input.cases ? { cases: input.cases } : {}),
          },
        },
      )
    ).data;
  }

  /** 查询云端自测详情。 */
  async domainSelfTest(slug: string, id: string): Promise<SelfTestDetail> {
    return (
      await this.request<{ data: SelfTestDetail }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/self-tests/${encodeURIComponent(
          id,
        )}`,
      )
    ).data;
  }

  /** 读取云端自测结构化反馈；404 时优雅回退返回 `null`。 */
  async domainSelfTestFeedback(
    slug: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    return await this.requestOptionalFeedback(
      `/api/v1/domains/${encodeURIComponent(slug)}/self-tests/${encodeURIComponent(
        id,
      )}/feedback`,
    );
  }

  async domainTemplate(
    slug: string,
    reference: string,
    versionId: string,
  ): Promise<{ version_id: string; template_content: string | null }> {
    const path = `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(
      reference,
    )}/template`;
    return (
      await this.request<{
        data: { version_id: string; template_content: string | null };
      }>(`${path}?version_id=${encodeURIComponent(versionId)}`)
    ).data;
  }

  async domainVersions(
    slug: string,
    reference: string,
    page = 1,
  ): Promise<{
    items: Array<{
      version_id: string;
      version: number;
      change_note: string | null;
      published_at: string;
    }>;
    total: number;
    page: number;
    limit: number;
    answer_version_id: string;
  }> {
    return await this.request(
      `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(
        reference,
      )}/versions?page=${page}&limit=20`,
    );
  }

  async submitCode(
    slug: string,
    reference: string,
    code: string,
    fileName: string,
    versionId: string,
  ): Promise<CreatedSubmission> {
    return await this.submitDomainCode(
      slug,
      reference,
      code,
      fileName,
      versionId,
    );
  }

  private async requestOptionalFeedback(
    path: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.request<
        {
          data?: Record<string, unknown>;
        } & Record<string, unknown>
      >(path);
      if (response && typeof response === "object") {
        return response.data && typeof response.data === "object"
          ? response.data
          : response;
      }
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    return await this.requestRaw<T>(path, {
      method: options.method ?? "GET",
      headers,
      body,
      authenticated: options.authenticated,
    });
  }

  private async requestRaw<T>(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated !== false;
    if (authenticated && !this.token) {
      throw new ApiError("请先登录 Neuro OJ", 401, "AUTH_REQUIRED");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
    if (authenticated && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await this.transport({
      url: new URL(path, `${normalizeServerUrl(this.serverUrl)}/`),
      method: options.method ?? "GET",
      headers,
      body: options.body,
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
