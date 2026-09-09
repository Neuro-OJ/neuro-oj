/**
 * MQ 非法消息容错 E2E。
 *
 * 通过 Redis 直接向评测队列写入非法 JSON，验证真实的容错行为：
 * 1. 消费者不会卡死——随后提交的正常任务仍能评测完成；
 * 2. 非法消息不会永久占用 processing（被消费端写入死信并移除）；
 * 3. 队列接口仍可用。
 */

import {
  apiGet,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
} from "../helper.ts";

const REDIS_CONTAINER = "noj-e2e-redis";
const QUEUE = "noj:judge:queue:medium";

/** 在 E2E Redis 容器内执行 redis-cli，失败时抛错（不静默跳过）。 */
async function redisCli(
  ...args: string[]
): Promise<string> {
  const cmd = new Deno.Command("docker", {
    args: ["exec", REDIS_CONTAINER, "redis-cli", ...args],
  });
  const { stdout, stderr, success } = await cmd.output();
  if (!success) {
    throw new Error(
      `docker exec ${REDIS_CONTAINER} 失败: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  return new TextDecoder().decode(stdout);
}

e2eTest("[e2e/mq-invalid] 非法消息不阻塞队列且被移出 processing", async () => {
  if (!isE2E) return;

  await redisCli("LPUSH", QUEUE, "not-json");

  // 1) 正常提交仍能完成（消费者未因毒消息卡死）
  const ts = Date.now().toString(36);
  const token = await registerUser(
    `mq_${ts}`,
    `mq_${ts}@test.com`,
    TEST_PASSWORD,
  );
  const problemId = await getProblemIdByNumber(1001);
  const submissionId = await submitCode(token, problemId, "print(1)");
  const result = await pollSubmission(token, submissionId, 60, 2000, true);
  if (result.status !== "finished") {
    throw new Error(`正常提交应评测完成，实际 ${result.status}`);
  }

  // 2) 非法消息最终不在 processing 中（最多等 15s，给 judge 拉取处理的时间）
  const deadline = Date.now() + 15_000;
  let processing = "";
  while (Date.now() < deadline) {
    processing = await redisCli("LRANGE", `${QUEUE}:processing`, "0", "-1");
    if (!processing.includes("not-json")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (processing.includes("not-json")) {
    throw new Error("非法消息仍留在 processing，消费者未处理毒消息");
  }

  // 3) 队列接口仍可用
  const adminToken = await getAdminToken();
  const { status, body } = await apiGet("/api/v1/queue", adminToken);
  if (status !== 200) {
    throw new Error(`队列接口应仍可用，实际 ${status}`);
  }
  const d = body as { stats?: { pending_count?: number } };
  if (typeof d.stats?.pending_count !== "number") {
    throw new Error("队列统计应仍返回数值");
  }
});
