import { ValidationError } from "./errors.ts";

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
