/**
 * 应用错误基类。
 * 所有已知的业务错误继承此类，由全局错误处理程序统一捕获并返回 JSON 响应。
 *
 * `code` 字段为机器可读的错误码，便于前端按错误类型做差异化处理或上报。
 * `requestId` 字段在 app.ts 的全局错误处理中填充，用于与服务端日志关联。
 * `meta` 字段携带额外数据（如 issue #102 USER_BANNED 携带 reason/until），
 * 由 app.ts onError 透传到 JSON 响应。
 */
export class AppError extends Error {
  /** HTTP 状态码 */
  statusCode: number;
  /** Hono 兼容字段——默认错误处理通过 err.status 读取状态码 */
  get status(): number {
    return this.statusCode;
  }
  /** 机器可读的错误码（如 "VALIDATION_ERROR"）；未显式传入时根据类名自动生成 */
  code: string;
  /** 请求关联 ID（由全局错误处理注入，便于日志追踪） */
  requestId?: string;
  /** 附加字段，会被原样透传到错误响应（issue #102 USER_BANNED 用） */
  meta?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code?: string,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code ?? "INTERNAL_ERROR";
    if (meta) this.meta = meta;
  }
}

/**
 * 冲突错误（HTTP 409）。
 * 用于资源重复场景（如用户名/邮箱已存在）。
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT_ERROR");
    this.name = "ConflictError";
  }
}

/**
 * 未授权错误（HTTP 401）。
 * 用于认证失败场景（如密码错误、令牌无效）。
 */
export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(message, 401, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/**
 * 验证错误（HTTP 400）。
 * 用于请求体格式或内容不符合要求。
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/**
 * 未找到错误（HTTP 404）。
 * 用于资源不存在场景（如题目/提交不存在）。
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/**
 * 请求错误（HTTP 400）。
 * 用于请求参数或内容错误。
 */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, "BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

/**
 * 禁止访问错误（HTTP 403）。
 * 用于权限不足场景（如普通用户尝试编辑管理题、
 * must_change_password=true 用户访问非白名单路径、
 * issue #102 USER_BANNED / IP_BLACKLISTED）。
 *
 * 支持可选 code 参数以区分不同禁止场景（issue #75 评审修复 M1）。
 * 支持可选 meta 参数携带额外数据（如 USER_BANNED 携带 reason/until）。
 */
export class ForbiddenError extends AppError {
  constructor(
    message: string,
    code?: string,
    meta?: Record<string, unknown>,
  ) {
    super(message, 403, code, meta);
    this.name = "ForbiddenError";
  }
}

/**
 * 服务不可用错误（HTTP 503）。
 * 用于关键依赖（Redis、数据库）不可用导致无法执行业务的场景。
 * 当前由限流相关 Redis 调用在连接失败时抛出（issue #73 fail-closed）。
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503, "SERVICE_UNAVAILABLE");
    this.name = "ServiceUnavailableError";
  }
}

/**
 * 请求过多错误（HTTP 429）。
 * 用于速率限制场景（如接口请求过于频繁）。
 *
 * 携带 headers 供 app.ts onError 设置响应头（如 Retry-After）。
 */
export class RateLimitedError extends AppError {
  headers?: Record<string, string>;

  constructor(message: string, retryAfter?: number) {
    super(message, 429, "RATE_LIMITED", { retry_after: retryAfter });
    this.name = "RateLimitedError";
    if (retryAfter !== undefined) {
      this.headers = { "Retry-After": String(retryAfter) };
    }
  }
}

/**
 * 搜索限流错误（HTTP 429，issue #100）。
 *
 * 与 RateLimitedError 等价的独立错误类，专用于搜索限流场景，
 * 便于在中间件中显式区分错误来源、保持错误类语义清晰。
 *
 * `meta.retry_after` 携带退避秒数，由 app.ts onError 透传到响应体。
 */
export class RateLimitError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, 429, "RATE_LIMITED", meta);
    this.name = "RateLimitError";
  }
}
