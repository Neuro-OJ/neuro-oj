/**
 * 提交后副作用（通知、对象清理、搜索索引）不参与主事务，也不得让主流程失败。
 *
 * 之前的实现直接在事务提交后 `await` 副作用：一旦通知写入或对象删除抛错，
 * HTTP 层返回 500，而数据库里的事实已经生效。客户端重试会撞上"用户不存在"
 * 或"已经注销"，用户看到的是失败，实际状态却已改变。这里统一收敛为
 * "记录日志并继续"，让调用方拿到与已提交事实一致的成功响应。
 *
 * 注意：只用于**已提交事实的派生物**。主事务内的写入、审计、锁内校验不得使用。
 */
import { logger } from "./logging.ts";

/** 执行提交后副作用；失败只记日志，不向调用方抛出。 */
export async function runBestEffort(
  action: string,
  run: () => unknown | Promise<unknown>,
  fields: Record<string, unknown> = {},
): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.error("提交后副作用失败（主流程已提交，忽略该错误）", {
      action,
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
