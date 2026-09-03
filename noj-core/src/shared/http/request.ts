import { BadRequestError, ValidationError } from "../base/errors.ts";

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
