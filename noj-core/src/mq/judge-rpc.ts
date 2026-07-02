//! Judge RPC 处理器。
//!
//! 监听 `noj:rpc:v1:judge:core` 队列中的 RPC 请求，
//! 处理 `get_image_allowlist` 等方法并返回响应。
//!
//! # 协议
//!
//! 请求队列: `noj:rpc:v1:judge:core` (List)
//! 响应队列: `noj:rpc:v1:judge:{judge_id}:response` (List)
//!
//! 请求格式: { "id": "<uuid>", "method": "<name>", "params": {...}, "timestamp": <int>, "judge_id": "<id>" }
//! 响应格式: { "id": "<uuid>", "result": {...}, "error": null|string, "timestamp": <int> }

import type { Redis } from "ioredis";
import { db } from "../db/connection.ts";
import { judgeImages } from "../db/schema.ts";
import { eq } from "drizzle-orm";

/** RPC 请求消息结构 */
interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
  timestamp: number;
}

/** RPC 响应消息结构 */
interface RpcResponse {
  id: string;
  result?: unknown;
  error?: string | null;
  timestamp: number;
}

/** 创建 RPC 响应 */
function createResponse(id: string, result?: unknown, error?: string | null): RpcResponse {
  return {
    id,
    result,
    error: error ?? null,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * 处理 get_image_allowlist 请求。
 * 从数据库查询所有 enabled 的 judge_images 记录。
 */
async function handleGetImageAllowlist(): Promise<{ images: { image: string; tag: string }[] }> {
  const images = await db
    .select({
      image: judgeImages.image,
      tag: judgeImages.tag,
    })
    .from(judgeImages)
    .where(eq(judgeImages.enabled, true));

  return { images };
}

/** 方法名到处理函数的映射 */
type MethodHandler = (params: unknown) => Promise<unknown>;

const handlers: Record<string, MethodHandler> = {
  get_image_allowlist: handleGetImageAllowlist,
};

/**
 * 启动 RPC 请求监听循环。
 *
 * 在 Redis 连接上 BRPOP 等待请求，分发到对应 handler，LPUSH 响应。
 *
 * @param redis - ioredis 实例
 * @param abortSignal - 可选的取消信号
 */
export async function startJudgeRpcHandler(
  redis: Redis,
  abortSignal?: AbortSignal,
): Promise<void> {
  const REQUEST_QUEUE = "noj:rpc:v1:judge:core";

  console.log("[judge-rpc] RPC handler started, waiting for requests...");

  while (!abortSignal?.aborted) {
    try {
      const result = await redis.brpop(REQUEST_QUEUE, 5);
      if (!result) continue;

      const [, rawMessage] = result;
      let request: Record<string, unknown>;

      try {
        request = JSON.parse(rawMessage);
      } catch {
        console.warn("[judge-rpc] Invalid request JSON, skipping");
        continue;
      }

      if (!request.id || !request.method) {
        console.warn("[judge-rpc] Request missing id or method, skipping");
        continue;
      }

      // 从请求中提取 judge_id（由 judge 端在消息顶层发送）
      const judgeId = request.judge_id as string | undefined;
      const responseQueue = judgeId
        ? `noj:rpc:v1:judge:${judgeId}:response`
        : `noj:rpc:v1:judge:${request.id}:response`;

      const handler = handlers[request.method as string];
      if (!handler) {
        console.warn(`[judge-rpc] Unknown method: ${request.method}`);
        const response = createResponse(request.id as string, undefined, `unknown method: ${request.method}`);
        await redis.lpush(responseQueue, JSON.stringify(response));
        continue;
      }

      // 执行 handler
      try {
        const result = await handler(request.params);
        const response = createResponse(request.id as string, result);
        await redis.lpush(responseQueue, JSON.stringify(response));
      } catch (err) {
        console.error(`[judge-rpc] Handler error for ${request.method}:`, err);
        const response = createResponse(
          request.id as string,
          undefined,
          err instanceof Error ? err.message : "internal error",
        );
        await redis.lpush(responseQueue, JSON.stringify(response));
      }
    } catch (err) {
      console.error("[judge-rpc] BRPOP error:", err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log("[judge-rpc] RPC handler stopped");
}
