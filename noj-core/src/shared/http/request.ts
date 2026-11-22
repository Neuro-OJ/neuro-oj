import { AppError, BadRequestError, ValidationError } from "../base/errors.ts";

/**
 * 判断值是否为普通对象（非 null、非数组）。
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 断言请求体为 JSON 对象，否则抛 BadRequestError。
 *
 * @throws {BadRequestError} 请求体不是 JSON 对象
 */
export function assertObjectBody(
  body: unknown,
): asserts body is Record<string, unknown> {
  if (!isObject(body)) {
    throw new BadRequestError("请求体必须为 JSON 对象");
  }
}

/**
 * 安全地解析请求体 JSON。
 * 捕获 JSON 解析错误并抛出 ValidationError。
 *
 * @param c - Hono 上下文（需包含 req.json 方法）
 * @returns 解析后的请求体
 * @throws {ValidationError} JSON 格式错误时抛出
 */
export async function parseJsonBody<T>(
  c: { req: { json: <U>() => Promise<U> } },
): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new ValidationError("请求体格式错误：需要有效的 JSON");
  }
}

/**
 * 读取 `Content-Length` 并对照上限预检（上传端点的**读体前**门禁）。
 *
 * 2026-11-02 rc/v0.11 审计 F6：题包导入原先在 `parseBody()` 之后才比较
 * `file.size`，即先付出 128 MiB 内存/带宽再拒绝。这里在消费请求体之前按声明长度
 * 快速失败；**不能**替代流式字节上限（客户端可以不发 Content-Length 或谎报），
 * 因此只作为第一道闸门，与代理层 `client_max_body_size` 共同构成上限契约。
 *
 * @param c Hono Context
 * @param maxBytes 允许的最大请求体字节数
 * @param label 错误文案里的资源名
 * @throws {AppError} 413 `UPLOAD_TOO_LARGE`
 */
export function assertDeclaredBodyWithin(
  c: { req: { header(name: string): string | undefined } },
  maxBytes: number,
  label: string,
): void {
  const raw = c.req.header("content-length");
  if (raw === undefined) return;
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) return;
  // multipart 边界与字段开销留 1 KiB 余量，避免恰好等于上限的合法请求被误拒
  if (declared <= maxBytes + 1024) return;
  throw new AppError(
    `${label}超过上限（${Math.floor(maxBytes / 1024 / 1024)} MiB）`,
    413,
    "UPLOAD_TOO_LARGE",
  );
}
