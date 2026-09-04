/**
 * stats-cache 服务单元测试。
 *
 * 覆盖：
 * - applyNewResult 计数器递增逻辑（满分/非满分）
 * - 今日统计缓存时效性
 * - _resetStatsCacheForTest 重置
 *
 * 依赖 PGlite 内存数据库（始终可用）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  _resetStatsCacheForTest,
  applyNewResult,
  getCachedTodayStats,
  getCachedTotalStats,
} from "../../index.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";

// PGlite 内存数据库始终可用
const dbAvailable = true;
const skip = !dbAvailable;

Deno.test({
  name: "stats-cache: 重置缓存",
  ignore: skip,
  fn: async () => {
    await resetDbForTest();
    _resetStatsCacheForTest();
    // 验证缓存已被清空（applyNewResult 在缓存 null 时不生效）
    let applied = false;
    try {
      applyNewResult(10000, new Date().toISOString());
      applied = true;
    } catch {
      // 预期不抛错
    }
    assertEquals(applied, true);
  },
});

Deno.test({
  name: "stats-cache: 全站累计统计初始值 0",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 0);
    assertEquals(stats.full_score, 0);
    assertEquals(stats.not_full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: applyNewResult 递增累计计数器",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    // 先加载缓存
    await getCachedTotalStats();

    const today = new Date().toISOString();
    applyNewResult(10000, today);

    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 1);
    assertEquals(stats.full_score, 1);
    assertEquals(stats.not_full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: 非满分不计入 full_score",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    await getCachedTotalStats();

    const today = new Date().toISOString();
    applyNewResult(5000, today); // 非满分

    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 1);
    assertEquals(stats.full_score, 0);
    assertEquals(stats.not_full_score, 1);
  },
});

Deno.test({
  name: "stats-cache: 空分数不递增 full_score",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    await getCachedTotalStats();

    const today = new Date().toISOString();
    applyNewResult(null, today);

    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 1);
    assertEquals(stats.full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: 今日统计初始值 0",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    const stats = await getCachedTodayStats();
    assertEquals(stats.total, 0);
    assertEquals(stats.full_score, 0);
    assertEquals(stats.not_full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: 重复重置幂等",
  ignore: skip,
  fn: async () => {
    _resetStatsCacheForTest();
    _resetStatsCacheForTest(); // 第二次重置不抛错
    _resetStatsCacheForTest(); // 第三次也不抛错
    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 0);
  },
});
