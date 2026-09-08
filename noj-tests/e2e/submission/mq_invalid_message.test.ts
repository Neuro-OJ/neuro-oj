/**
 * MQ 非法消息容错 E2E。
 *
 * 通过 Redis 直接向评测队列写入非法 JSON，验证消费者不崩溃、队列仍可用。
 */
import { apiGet, e2eTest, getAdminToken, isE2E } from "../helper.ts";

async function pushInvalidMessage(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: [
        "exec",
        "noj-e2e-redis",
        "redis-cli",
        "LPUSH",
        "noj:judge:queue:medium",
        "not-json",
      ],
    });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}

e2eTest("[e2e/mq-invalid] 非法消息不阻塞队列", async () => {
  if (!isE2E) return;
  const pushed = await pushInvalidMessage();
  if (!pushed) {
    console.log("  ⚠ docker exec 失败，跳过");
    return;
  }
  const adminToken = await getAdminToken();
  const { status, body } = await apiGet("/api/v1/queue", adminToken);
  if (status !== 200) throw new Error("队列接口应仍可用，实际 " + status);
  const d = body as { stats?: { pending_count?: number } };
  if (typeof d.stats?.pending_count !== "number") {
    throw new Error("队列统计应仍返回数值");
  }
});
