import { createConsumerRedis } from "./connection.ts";
import { saveEvaluationResult } from "../services/submissions.ts";
import { logJudgeResultReceived } from "../lib/logging.ts";
import type { JudgeResult } from "../types/index.ts";

/**
 * 评测结果队列名称。
 * noj-judge 将评测结果 LPUSH 到此列表，消费者通过 BRPOP 阻塞读取。
 */
const RESULT_QUEUE = "noj:judge:results";

/**
 * BRPOP 超时时间（秒）。
 * 超时后自动重试，防止连接因长时间空闲而断开。
 */
const BLPOP_TIMEOUT = 10;

/** 初始重试延迟（ms）。 */
const INITIAL_RETRY_DELAY_MS = 1_000;
/** 最大重试延迟（ms）。 */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * 消费者活跃状态标识。
 * 供健康检查端点查询消费者是否在正常运行。
 */
export let consumerAlive = false;

/**
 * 启动评测结果消费者（带自动重连）。
 *
 * 在 `startResultConsumer` 因 Redis 断开等原因退出时，
 * 使用指数退避策略自动创建新连接并重新启动消费。
 * 此函数不会正常返回——它会持续尝试重连。
 */
export async function startResultConsumerWithRetry(): Promise<void> {
  let retryCount = 0;

  while (true) {
    consumerAlive = false;

    console.log("结果消费者正在启动...");

    try {
      await startResultConsumer();
    } catch (err) {
      // startResultConsumer 内部已捕获所有预期错误；
      // 走到此处的异常是未预期的严重错误。
      console.error(
        "结果消费者异常退出:",
        err instanceof Error ? err.message : String(err),
      );
    }

    consumerAlive = false;

    // 指数退避：1s → 2s → 4s → 8s → ... → 上限 30s
    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
      MAX_RETRY_DELAY_MS,
    );
    retryCount++;

    console.warn(
      `结果消费者将在 ${delay}ms 后重启（重试 #${retryCount}）...`,
    );

    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * 启动评测结果消费者（核心循环）。
 *
 * 在独立异步循环中运行，通过 BRPOP 阻塞等待 noj-judge 发布的评测结果，
 * 解析后持久化到数据库。
 *
 * 此函数内部处理所有预期的连接错误和解析错误，
 * 仅在不可恢复时返回（由外层 `startResultConsumerWithRetry` 负责重启）。
 */
async function startResultConsumer(): Promise<void> {
  const redis = createConsumerRedis();

  // 连接 Redis
  try {
    await redis.connect();
  } catch (err) {
    console.error(
      "结果消费者 Redis 连接失败:",
      err instanceof Error ? err.message : String(err),
    );
    return; // 连接失败，由外层重试循环处理
  }

  consumerAlive = true;
  console.log("结果消费者启动，等待评测结果...");

  // @ts-ignore - ioredis 的 brpop 类型在 Deno 中解析受限
  while (true) {
    try {
      // BRPOP 返回 [key, value] 或 null
      const result: [string, string] | null = await redis.brpop(
        RESULT_QUEUE,
        BLPOP_TIMEOUT,
      );

      if (!result) {
        // 超时，继续循环
        continue;
      }

      const [, rawJson] = result;

      let judgeResult: JudgeResult;
      try {
        judgeResult = JSON.parse(rawJson);
      } catch (parseErr) {
        console.error(
          "评测结果 JSON 解析失败，跳过:",
          parseErr instanceof Error ? parseErr.message : String(parseErr),
        );
        continue;
      }

      if (!judgeResult.submission_id) {
        console.error("评测结果缺少 submission_id，跳过");
        continue;
      }

      logJudgeResultReceived(
        judgeResult.submission_id,
        judgeResult.status,
        judgeResult.score,
      );

      try {
        await saveEvaluationResult(judgeResult);
        console.log(
          `评测结果已持久化: ${judgeResult.submission_id}`,
        );
      } catch (dbErr) {
        console.error(
          `评测结果持久化失败 (submission=${judgeResult.submission_id}):`,
          dbErr instanceof Error ? dbErr.message : String(dbErr),
        );
        // 不中断循环，错误仅记录日志
      }
    } catch (err) {
      console.error(
        "结果消费者错误:",
        err instanceof Error ? err.message : String(err),
      );
      // 短暂等待后重试，避免空转
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
