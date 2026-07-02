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
//! 请求格式: { "id": "<uuid>", "method": "<name>", "params": {...}, "timestamp": <int> }
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
      let request: RpcRequest;

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

      // 分发到 handler
      const handler = handlers[request.method];
      if (!handler) {
        console.warn(`[judge-rpc] Unknown method: ${request.method}`);
        const response = createResponse(request.id, undefined, `unknown method: ${request.method}`);
        const responseQueue = `noj:rpc:v1:judge:${extractJudgeId(rawMessage)}:response`;
        await redis.lpush(responseQueue, JSON.stringify(response));
        continue;
      }

      // 执行 handler
      try {
        const result = await handler(request.params);
        const response = createResponse(request.id, result);

        // 响应队列：从请求来源推导 judge_id
        // 注意：实际运行时，judge 连接 BRPOP 自己的响应队列
        // 由于我们不知道 judge_id，该实现需要改进
        // 当前简化实现：将响应推回请求队列，由调用方自行匹配 ID

        // TODO: 确定 judge_id 的传递机制
        // 方案 1: 请求消息中包含 judge_id 字段
        // 方案 2: 固定响应队列，judge 端按 request_id 过滤
        // 当前采用方案 2：固定一个响应队列，judge 根据 ID 匹配
        const judgeId = (request as Record<string, unknown>).judge_id as string | undefined;
        const responseQueue = judgeId
          ? `noj:rpc:v1:judge:${judgeId}:response`
          : "noj:rpc:v1:judge:response";

        await redis.lpush(responseQueue, JSON.stringify(response));
      } catch (err) {
        console.error(`[judge-rpc] Handler error for ${request.method}:`, err);
        const response = createResponse(
          request.id,
          undefined,
          err instanceof Error ? err.message : "internal error",
        );
        const responseQueue = `noj:rpc:v1:judge:${extractJudgeId(rawMessage)}:response`;
        await redis.lpush(responseQueue, JSON.stringify(response));
      }
    } catch (err) {
      console.error("[judge-rpc] BRPOP error:", err);
      // 等待后重试
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log("[judge-rpc] RPC handler stopped");
}

/**
 * 从请求消息中提取 judge_id。
 * 当前简化实现：固定返回空字符串（使用默认响应队列）。
 * TODO: 从请求消息的 params 或自定义 header 中提取 judge_id。
 */
function extractJudgeId(_rawMessage: string): string {
  // 简化实现：所有响应推入固定响应队列
  // judge 端按 request_id 匹配过滤
  return "response";
}
