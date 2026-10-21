/**
 * 设置缓存的**跨副本失效**测试（2026-09-12 架构评审 §2.6）。
 *
 * 缺陷背景：`system-settings.ts` 的配置缓存是进程内的，失效此前只做本地
 * `cache.delete()`，没有任何跨副本通道 → 多副本下"A 副本改设置、B 副本永不感知"。
 *
 * 关键语义（容易修错的地方）：`getSetting()` 在缓存未命中时**不回查 DB**，
 * 而是走 env → default 兜底。因此跨副本失效必须"重新加载"而不是"仅删除"——
 * 只删缓存会让副本读到默认值而不是真实的新 DB 值。本测试专门断言这一点。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
  initEventSubscriber,
} from "../../../../shared/sse/event-bus.ts";
import {
  _resetSystemSettingsForTest,
  getSetting,
  initSystemSettings,
  refreshSettingsCache,
  registerSettingsInvalidationListener,
  updateSetting,
} from "../../system/services/system-settings.ts";

const RUNTIME_KEY = "legal_contact";
const ACTOR_ID = "0";

/** 轮询等待异步刷新生效（避免固定 sleep 造成的 flaky） */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

Deno.test({
  name: "system-settings: 收到其它副本的变更通知后能读到新值（不是默认值）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const listener = registerSettingsInvalidationListener();

    try {
      // 本副本写入 A（同时清本地缓存）
      await updateSetting(RUNTIME_KEY, "副本A的值", ACTOR_ID);
      assertEquals(getSetting(RUNTIME_KEY)?.value, "副本A的值");

      // 模拟"另一个副本"直接改库（绕过本副本的缓存）
      await db
        .update(systemSettings)
        .set({ value: JSON.stringify("副本B的值") })
        .where(eq(systemSettings.key, RUNTIME_KEY));

      // 缓存仍在 → 本副本读到的还是旧值（这正是多副本不一致的现象）
      assertEquals(
        getSetting(RUNTIME_KEY)?.value,
        "副本A的值",
        "未收到通知前应命中本地缓存（说明缓存确实存在）",
      );

      // 收到跨副本通知（等价于订阅到 Redis noj:events:settings）
      _dispatchToLocalListenersForTest(
        Channels.settings,
        JSON.stringify({ type: "settings:changed", key: RUNTIME_KEY }),
      );

      const converged = await waitFor(
        () => getSetting(RUNTIME_KEY)?.value === "副本B的值",
      );
      assertEquals(
        converged,
        true,
        "收到通知后应重新加载 DB 并读到新值；若只 delete 缓存会读到 default 而非 DB 值",
      );
      // 来源必须是 db（而不是 default/env 兜底）
      assertEquals(getSetting(RUNTIME_KEY)?.source, "db");
    } finally {
      listener.stop();
      await listener.done;
    }
  },
});

Deno.test({
  name: "system-settings: refreshSettingsCache 全量刷新按 key 精确生效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    _resetSystemSettingsForTest();
    await initSystemSettings();

    await updateSetting(RUNTIME_KEY, "初始值", ACTOR_ID);
    await db
      .update(systemSettings)
      .set({ value: JSON.stringify("外部改动") })
      .where(eq(systemSettings.key, RUNTIME_KEY));

    await refreshSettingsCache(RUNTIME_KEY);
    assertEquals(getSetting(RUNTIME_KEY)?.value, "外部改动");

    // 全量刷新同样生效
    await db
      .update(systemSettings)
      .set({ value: JSON.stringify("第二次外部改动") })
      .where(eq(systemSettings.key, RUNTIME_KEY));
    await refreshSettingsCache();
    assertEquals(getSetting(RUNTIME_KEY)?.value, "第二次外部改动");
  },
});

Deno.test({
  name: "system-settings: 真实 Redis 通知触发跨副本缓存重载并可停止",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!Deno.env.get("REDIS_URL")) {
      throw new Error("真实 Redis 通知回归必须由测试启动器提供 REDIS_URL");
    }
    await initRedisForTest();
    const db = getDb();
    _resetSystemSettingsForTest();
    await initSystemSettings();

    const subscriber = initEventSubscriber();
    const listener = registerSettingsInvalidationListener();
    try {
      await updateSetting(RUNTIME_KEY, "真实副本A的值", ACTOR_ID);
      await db
        .update(systemSettings)
        .set({ value: JSON.stringify("真实副本B的值") })
        .where(eq(systemSettings.key, RUNTIME_KEY));
      assertEquals(getSetting(RUNTIME_KEY)?.value, "真实副本A的值");

      // 使用真实 Redis 发布，不调用本地测试分发器。订阅建立前的消息可能丢失，
      // 因此在本 run 专用 Redis 上短暂重试，直到收到通知或明确超时。
      const message = JSON.stringify({
        type: "settings:changed",
        key: RUNTIME_KEY,
      });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await getRedis().publish(Channels.settings, message);
        if (getSetting(RUNTIME_KEY)?.value === "真实副本B的值") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assertEquals(getSetting(RUNTIME_KEY)?.value, "真实副本B的值");
      assertEquals(getSetting(RUNTIME_KEY)?.source, "db");
    } finally {
      listener.stop();
      subscriber.stop();
      await Promise.allSettled([listener.done, subscriber.done]);
    }
  },
});
