/**
 * 升级副本占用原用户正常提交额度（Handbook §4.4；2026-10-11 复审问题 9）。
 *
 * 需要真实 Redis（本环境默认 `redis://127.0.0.1:6379/`）；`NOJ_ENV=test` 下需显式
 * 打开 `RATE_LIMIT_ENABLED` 才会真正计数（与平台既有测试约定一致）。
 *
 * 覆盖：
 * - 超额度的批量升级返回结构化**延期**信号（不是失败、不是异常）；
 * - 同一 `jobItemId`（副本）重派只扣一次额度；
 * - 与普通提交共享同一份用户额度；
 * - 管理员代升级扣**原用户**预算（actor 不参与计费）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { tryConsumeRateLimit } from "../../../system/index.ts";
import { consumeSubmissionQuotaForUpgrade } from "../../services/versioning/upgrade-quota.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";

// 测试环境默认关闭限流：仅在**单个用例内**临时开启并在 finally 还原。
// 不能在模块顶层 set：Deno 测试文件共享同一进程，泄漏会让后续所有文件的
// 升级派发都开始扣真实额度，最终被延期（2026-10-11 集成验收命中的整目录失败）。
const RATE_LIMIT_ENV_KEY = "RATE_LIMIT_ENABLED";

/** 在限流开启的环境下运行 `fn`，结束后还原为进入前的值（含失败路径）。 */
async function withRateLimitEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get(RATE_LIMIT_ENV_KEY);
  Deno.env.set(RATE_LIMIT_ENV_KEY, "true");
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(RATE_LIMIT_ENV_KEY);
    else Deno.env.set(RATE_LIMIT_ENV_KEY, previous);
  }
}

await initRedisForTest();

const LIMIT = { windowSec: 60, max: 2 };

/** 唯一标记，避免与其它用例/进程共用 Redis 键空间。 */
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function cleanup(userIds: string[]): Promise<void> {
  const redis = getRedis();
  for (const id of userIds) {
    const keys: string[] = [];
    const pattern = `hardening:upgrade-quota:item:${id}:*`;
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    keys.push(`ratelimit:hardening:submission:user:${id}`);
    if (keys.length > 0) await redis.del(...keys);
  }
}

Deno.test({
  name:
    "upgrade quota(#9): 超出正常额度的批量升级返回延期信号（不失败、不抛错）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-user");
      try {
        const results = [];
        for (let i = 0; i < 4; i++) {
          results.push(
            await consumeSubmissionQuotaForUpgrade(
              userId,
              uniqueId(`item-${i}`),
              {
                limit: LIMIT,
              },
            ),
          );
        }
        // 前 2 个副本占用额度成功，其余必须给出延期信号
        assertEquals(results.slice(0, 2), [{ ok: true }, { ok: true }]);
        const deferred = results.slice(2);
        assertEquals(deferred.length, 2);
        for (const result of deferred) {
          assertEquals(result.ok, false);
          if (!result.ok) {
            assertEquals(
              result.retryAfterMs > 0,
              true,
              "延期信号必须带等待时长",
            );
            assertEquals(result.retryAfterMs <= 60_000, true);
          }
        }
      } finally {
        await cleanup([userId]);
      }
    }),
});

Deno.test({
  name: "upgrade quota(#9): 同一副本重派只扣一次额度",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-idem");
      const itemId = uniqueId("item-a");
      try {
        // 额度 2：A 扣 1，A 再扣（重派）不得再占额度，因此 B 仍应成功
        const first = await consumeSubmissionQuotaForUpgrade(userId, itemId, {
          limit: LIMIT,
        });
        const replay = await consumeSubmissionQuotaForUpgrade(userId, itemId, {
          limit: LIMIT,
        });
        const other = await consumeSubmissionQuotaForUpgrade(
          userId,
          uniqueId("item-b"),
          { limit: LIMIT },
        );
        assertEquals(first, { ok: true });
        assertEquals(replay, { ok: true }, "重派必须幂等放行");
        assertEquals(
          other,
          { ok: true },
          "重派若重复扣费，第三个副本会被误判为超额",
        );

        // 真正超额（第 3 次不同副本）仍会被延期
        const overflow = await consumeSubmissionQuotaForUpgrade(
          userId,
          uniqueId("item-c"),
          { limit: LIMIT },
        );
        assertEquals(overflow.ok, false);
      } finally {
        await cleanup([userId]);
      }
    }),
});

Deno.test({
  name: "upgrade quota(#9): 与普通提交共享额度，管理员代升级扣原用户预算",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const sourceUserId = uniqueId("quota-source");
      const adminId = uniqueId("quota-admin");
      try {
        // 原用户已用掉 2 次普通提交额度（同一键）
        await tryConsumeRateLimit(`submission:user:${sourceUserId}`, LIMIT);
        await tryConsumeRateLimit(`submission:user:${sourceUserId}`, LIMIT);

        // 管理员代升级：额度不足 → 延期（扣的是原用户预算）
        const delegated = await consumeSubmissionQuotaForUpgrade(
          sourceUserId,
          uniqueId("item-delegated"),
          { limit: LIMIT },
        );
        assertEquals(delegated.ok, false, "原用户额度已用尽时必须延期");

        // actor（管理员）自己的额度未被占用
        const adminOwn = await tryConsumeRateLimit(
          `submission:user:${adminId}`,
          LIMIT,
        );
        assertEquals(adminOwn.allowed, true, "管理员预算不得被代升级占用");

        // 直接核对 Redis 键：原用户计数已耗尽（2 次普通提交 + 1 次被拒的代升级）。
        // 注意：被拒绝的尝试同样计入固定窗口（与 enforceRateLimit 一致），
        // 因此额度"只多不少"，不会因为延期副本而放行超额。
        const redis = getRedis();
        assertEquals(
          await redis.get(
            `ratelimit:hardening:submission:user:${sourceUserId}`,
          ),
          "3",
        );
        // 管理员自己的计数只来自上面那次显式调用（代升级没有占用 actor 预算）
        assertEquals(
          await redis.get(`ratelimit:hardening:submission:user:${adminId}`),
          "1",
        );
      } finally {
        await cleanup([sourceUserId, adminId]);
      }
    }),
});
