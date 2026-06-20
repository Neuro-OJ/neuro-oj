/**
 * 应用错误基类。
 * 所有已知的业务错误继承此类，由全局错误处理程序统一捕获并返回 JSON 响应。
 */
export class AppError extends Error {
  /** HTTP 状态码 */
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

/**
 * 冲突错误（HTTP 409）。
 * 用于资源重复场景（如用户名/邮箱已存在）。
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

/**
 * 未授权错误（HTTP 401）。
 * 用于认证失败场景（如密码错误、令牌无效）。
 */
export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

/**
 * 验证错误（HTTP 400）。
 * 用于请求体格式或内容不符合要求。
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

/**
 * 未找到错误（HTTP 404）。
 * 用于资源不存在场景（如题目/提交不存在）。
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

/**
 * 请求错误（HTTP 400）。
 * 用于请求参数或内容错误。
 */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "BadRequestError";
  }
}
