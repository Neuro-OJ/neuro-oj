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
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  submissionQuotaRedisKey,
  submissionUserQuotaRedisKey,
  tryConsumeRateLimit,
} from "../../../platform/system/index.ts";
import {
  consumeSubmissionQuotaForUpgrade,
  UPGRADE_QUOTA_CONSUME_SCRIPT,
  upgradeQuotaMarkerKey,
} from "../../services/versioning/upgrade-quota.ts";
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
    keys.push(
      submissionQuotaRedisKey("code", id),
      submissionQuotaRedisKey("contest_code", id),
      submissionQuotaRedisKey("objective", id),
    );
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

// ── 2026-10-11 复审问题 5：占位与扣费必须是同一次原子操作 ──────────────────────

Deno.test({
  name: "upgrade quota(#5): 响应丢失后重试不重复扣费，计数与标记保持一致",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-lost");
      const itemId = uniqueId("item-lost");
      const marker = upgradeQuotaMarkerKey(userId, itemId);
      const counter = submissionUserQuotaRedisKey(userId);
      try {
        // 直接执行**同一个**原子脚本一次 = "服务端已完成扣费，但响应在网络上丢了"
        const raw = await getRedis().eval(
          UPGRADE_QUOTA_CONSUME_SCRIPT,
          2,
          marker,
          counter,
          new Date().toISOString(),
          86_400_000,
          60_000,
          LIMIT.max,
        ) as unknown as number[];
        assertEquals(Number(raw[0]), 1, "脚本必须原子完成扣费与标记");

        // 客户端重试：幂等放行且计数保持 1（旧实现会因为"标记已写"而放过未扣费的副本）
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await getRedis().get(counter), "1");

        // 同一用户的下一个副本仍能正常扣费（额度未被整体锁死）
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, uniqueId("item-b"), {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await getRedis().get(counter), "2");

        // 超额副本：延期且**不留下任何标记**（标记只代表扣费完成）
        const overflowItem = uniqueId("item-overflow");
        const overflow = await consumeSubmissionQuotaForUpgrade(
          userId,
          overflowItem,
          { limit: LIMIT },
        );
        assertEquals(overflow.ok, false);
        assertEquals(
          await getRedis().exists(upgradeQuotaMarkerKey(userId, overflowItem)),
          0,
          "额度不足不得留下'已占位'标记",
        );
      } finally {
        await cleanup([userId]);
      }
    }),
});

Deno.test({
  name: "upgrade quota(#5): 扣费阶段失败时不留占位，恢复后重试正确扣费一次",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-half");
      const itemId = uniqueId("item-half");
      const marker = upgradeQuotaMarkerKey(userId, itemId);
      const counter = submissionUserQuotaRedisKey(userId);
      const redis = getRedis();
      try {
        // 故障注入：把计数键写成非整数 → 脚本内 INCR 报错（等价于"扣费阶段失败"）。
        // 关键断言：此时**不得**留下幂等标记，否则重试会跳过扣费直接放行。
        await redis.set(counter, "not-a-number");
        const failed = await consumeSubmissionQuotaForUpgrade(userId, itemId, {
          limit: LIMIT,
        });
        assertEquals(failed.ok, false, "扣费失败必须 fail-closed 延期");
        assertEquals(
          await redis.exists(marker),
          0,
          "扣费失败绝不能留下幂等标记",
        );

        // 故障恢复：重试必须真正扣费一次并成功
        await redis.del(counter);
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await redis.get(counter), "1");
        assertEquals(await redis.exists(marker), 1);

        // 再次重试仍然幂等
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await redis.get(counter), "1");
      } finally {
        await redis.del(counter);
        await cleanup([userId]);
      }
    }),
});

Deno.test({
  name: "upgrade quota(#5): 连接重建（断连恢复）后幂等与计数仍然正确",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-reconnect");
      const itemId = uniqueId("item-reconnect");
      try {
        const counter = submissionUserQuotaRedisKey(userId);
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await getRedis().get(counter), "1");

        // 等价于"断连后恢复"：丢弃单例连接引用，下一次 getRedis() 重新建立连接
        resetRedisForTest();
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
          }),
          { ok: true },
          "连接重建后幂等标记仍然有效",
        );
        const redis = getRedis();
        assertEquals(await redis.get(counter), "1", "重连不得重复扣费");

        // 新连接上其它副本仍能正常扣费
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, uniqueId("item-x"), {
            limit: LIMIT,
          }),
          { ok: true },
        );
        assertEquals(await redis.get(counter), "2");
      } finally {
        await cleanup([userId]);
      }
    }),
});

// ── 2026-10-11 复审问题 6：按副本题型选择额度桶 ────────────────────────────────

Deno.test({
  name:
    "upgrade quota(#6): 三个额度桶各自独立——桶内耗尽才延期，且与对应正常提交同键",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-bucket");
      try {
        const redis = getRedis();
        // 代码桶：先用**普通提交**入口耗尽（证明同键），再升级 → 延期
        await tryConsumeRateLimit(`submission:user:${userId}`, LIMIT);
        await tryConsumeRateLimit(`submission:user:${userId}`, LIMIT);
        assertEquals(
          (await consumeSubmissionQuotaForUpgrade(userId, uniqueId("code-1"), {
            limit: LIMIT,
            bucket: "code",
          })).ok,
          false,
          "代码桶耗尽后代码升级必须延期",
        );

        // 竞赛桶独立：同一用户仍可扣竞赛桶
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(
            userId,
            uniqueId("contest-1"),
            {
              limit: LIMIT,
              bucket: "contest_code",
              contestId: uniqueId("contest"),
            },
          ),
          { ok: true },
          "竞赛桶未被占用，竞赛升级不得被代码桶拖累",
        );
        // 客观题桶同样独立
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, uniqueId("obj-1"), {
            limit: LIMIT,
            bucket: "objective",
          }),
          { ok: true },
          "客观题桶未被占用",
        );
        // 三个桶确实是三条独立计数键
        assertEquals(
          await redis.get(submissionQuotaRedisKey("code", userId)),
          "3",
        );
        assertEquals(
          await redis.get(submissionQuotaRedisKey("contest_code", userId)),
          "1",
        );
        assertEquals(
          await redis.get(submissionQuotaRedisKey("objective", userId)),
          "1",
        );

        // 竞赛桶耗尽（第 3 次）后，竞赛升级延期
        await tryConsumeRateLimit(
          `contest-submission:user:${userId}`,
          LIMIT,
        );
        assertEquals(
          (await consumeSubmissionQuotaForUpgrade(
            userId,
            uniqueId("contest-2"),
            { limit: LIMIT, bucket: "contest_code" },
          )).ok,
          false,
          "竞赛桶达到上限后必须延期",
        );
        // 缺省 bucket = code（向后兼容）
        assertEquals(
          (await consumeSubmissionQuotaForUpgrade(userId, uniqueId("code-2"), {
            limit: LIMIT,
          })).ok,
          false,
          "缺省桶必须是 code",
        );
      } finally {
        await cleanup([userId]);
      }
    }),
});

Deno.test({
  name: "upgrade quota(#6): 非 code 桶的重派同样只扣一次（幂等跨桶一致）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withRateLimitEnabled(async () => {
      const userId = uniqueId("quota-bucket-idem");
      const itemId = uniqueId("obj-item");
      try {
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
            bucket: "objective",
          }),
          { ok: true },
        );
        assertEquals(
          await consumeSubmissionQuotaForUpgrade(userId, itemId, {
            limit: LIMIT,
            bucket: "objective",
          }),
          { ok: true },
          "同一副本重派必须幂等",
        );
        assertEquals(
          await getRedis().get(submissionQuotaRedisKey("objective", userId)),
          "1",
        );
      } finally {
        await cleanup([userId]);
      }
    }),
});
