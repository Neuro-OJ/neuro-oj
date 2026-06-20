import { createConsumerRedis } from "./connection.ts";
import { saveEvaluationResult } from "../services/submissions.ts";
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

/**
 * 启动评测结果消费者。
 *
 * 在独立异步循环中运行，通过 BRPOP 阻塞等待 noj-judge 发布的评测结果，
 * 解析后持久化到数据库。
 *
 * 此函数不会返回（除非遇到不可恢复的错误），
 * 应在 Deno.serve 之前或之后以 Promise 形式并行运行。
 */
export async function startResultConsumer(): Promise<void> {
  const redis = createConsumerRedis();

  // 连接 Redis
  try {
    await redis.connect();
  } catch (err) {
    console.error(
      "结果消费者 Redis 连接失败:",
      err instanceof Error ? err.message : String(err),
    );
    return; // 连接失败不进入主循环，由外层 catch 处理重新拉起
  }

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

      console.log(
        `收到评测结果: submission_id=${judgeResult.submission_id}, status=${judgeResult.status}, score=${judgeResult.score}`,
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
