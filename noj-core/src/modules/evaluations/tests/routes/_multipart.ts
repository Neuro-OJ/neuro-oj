/**
 * multipart 提交路由测试共享辅助。
 *
 * `submissions.test.ts` 需要构造 `multipart/form-data` 请求（走 busboy 解析
 * 路径），而测试 helper 的 `jsonRequest()` 强制 `application/json`，因此这里
 * 提供 `multipartRequest()`：`FormData` → `new Request()` → `app.fetch()`。
 *
 * Fake Redis 直接复用 MQ 测试的 `startFakeRedis`（RESP mock），避免复制一份
 * 协议解析实现。
 */

export { startFakeRedis } from "../mq/_setup.ts";
export type { FakeRedis } from "../mq/_setup.ts";

/**
 * 在测试体执行期间临时关闭提交限流（执行后恢复原值）。
 *
 * 仓库内其他测试文件（如 `self-tests.test.ts`）会在模块顶层
 * `RATE_LIMIT_ENABLED=true` 且从不恢复，`deno test` 同进程运行时会污染后续
 * 文件的提交路由；而共享的 fake Redis 不实现 INCR/PTTL，限流会 fail-closed
 * 抛 503/429。提交路由的限流行为已有专门测试覆盖，这里聚焦分派逻辑，故显式关闭。
 *
 * @param fn 测试体
 * @returns fn 的返回值
 */
export async function withoutSubmissionRateLimit<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Deno.env.get("RATE_LIMIT_ENABLED");
  Deno.env.set("RATE_LIMIT_ENABLED", "false");
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("RATE_LIMIT_ENABLED");
    else Deno.env.set("RATE_LIMIT_ENABLED", previous);
  }
}

/**
 * 构造 multipart/form-data 请求并通过 Hono 路由栈执行。
 *
 * @param app Hono 实例（`createApp()`）
 * @param path 请求路径
 * @param fields 普通表单字段（如 `problem_id`）
 * @param file `file` 字段（文件名 + 内容）
 * @param token 可选 Bearer token
 * @returns 路由响应
 */
export function multipartRequest(
  // Hono 实例泛型多变体，测试 helper 用 any 保持与 jsonRequest 同级别宽松。
  // deno-lint-ignore no-explicit-any
  app: any,
  path: string,
  fields: Record<string, string>,
  file: { name: string; data: Uint8Array; type?: string },
  token?: string,
): Promise<Response> {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  // .buffer cast：规避 Deno 2.x 下 Uint8Array<ArrayBufferLike> 与 BlobPart
  // 的泛型不兼容（TS2322），行为等价。
  fd.append(
    "file",
    new File([file.data.buffer as ArrayBuffer], file.name, {
      type: file.type ?? "application/octet-stream",
    }),
  );

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: fd,
    }),
  );
}
