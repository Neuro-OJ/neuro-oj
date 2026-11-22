/**
 * 低峰时段纯函数测试（无需数据库，`deno task test:domain knowledge` 一并运行）。
 *
 * 覆盖：时段内外、跨零点、边界（开始在内、结束不在内）、`nextWindowStart`
 * 落在当天/次日、跨月边界、非法窗口回退默认、UTC+8 换算。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  DEFAULT_OFFPEAK_WINDOW,
  isValidWindow,
  isWithinWindow,
  nextWindowStart,
  parseWindow,
} from "./offpeak.ts";

/** 构造北京时间某个时刻对应的 Date（北京时间 = UTC+8）。 */
function cst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

const W = "00:30-08:30";

function assertInside(now: Date, w: string) {
  assertEquals(isWithinWindow(now, w), true, now.toISOString());
}
function assertOutside(now: Date, w: string) {
  assertEquals(isWithinWindow(now, w), false, now.toISOString());
}

Deno.test("offpeak: 默认窗口解析为 00:30-08:30", () => {
  assertEquals(parseWindow(DEFAULT_OFFPEAK_WINDOW), {
    startMin: 30,
    endMin: 510,
  });
});

Deno.test("offpeak: 时段内/外（北京时间）", () => {
  assertInside(cst(2026, 11, 13, 3, 0), W);
  assertOutside(cst(2026, 11, 13, 0, 29), W);
  assertOutside(cst(2026, 11, 13, 8, 30), W);
  assertOutside(cst(2026, 11, 13, 12, 0), W);
  // UTC 19:00 = 北京次日 03:00，在时段内。
  assertInside(new Date("2026-11-13T19:00:00Z"), W);
});

Deno.test("offpeak: 边界——开始时刻在内、结束时刻不在内", () => {
  assertInside(cst(2026, 11, 13, 0, 30), W);
  assertInside(cst(2026, 11, 13, 8, 29), W);
  assertOutside(cst(2026, 11, 13, 8, 30), W);
});

Deno.test("offpeak: 跨零点窗口 22:00-06:00", () => {
  const w = "22:00-06:00";
  assertInside(cst(2026, 11, 13, 22, 0), w);
  assertInside(cst(2026, 11, 13, 23, 59), w);
  assertInside(cst(2026, 11, 14, 0, 0), w);
  assertInside(cst(2026, 11, 14, 5, 59), w);
  assertOutside(cst(2026, 11, 14, 6, 0), w);
  assertOutside(cst(2026, 11, 13, 21, 59), w);
  assertOutside(cst(2026, 11, 13, 12, 0), w);
});

Deno.test("offpeak: nextWindowStart 当天/次日", () => {
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 0, 0), W).toISOString(),
    cst(2026, 11, 13, 0, 30).toISOString(),
  );
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 0, 30), W).toISOString(),
    cst(2026, 11, 13, 0, 30).toISOString(),
  );
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 3, 0), W).toISOString(),
    cst(2026, 11, 14, 0, 30).toISOString(),
  );
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 12, 0), W).toISOString(),
    cst(2026, 11, 14, 0, 30).toISOString(),
  );
  // 跨零点窗口：20:00 → 当天 22:00；23:00 → 次日 22:00。
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 20, 0), "22:00-06:00").toISOString(),
    cst(2026, 11, 13, 22, 0).toISOString(),
  );
  assertEquals(
    nextWindowStart(cst(2026, 11, 13, 23, 0), "22:00-06:00").toISOString(),
    cst(2026, 11, 14, 22, 0).toISOString(),
  );
});

Deno.test("offpeak: 跨年边界（次日为 1 月 1 日）", () => {
  assertEquals(
    nextWindowStart(cst(2026, 12, 31, 12, 0), W).toISOString(),
    cst(2027, 1, 1, 0, 30).toISOString(),
  );
});

Deno.test("offpeak: 非法窗口回退默认", () => {
  for (
    const bad of [
      "",
      "0:30-08:30",
      "25:00-26:00",
      "00:30",
      "00:30-08:60",
      "08:30-08:30",
      "abc",
    ]
  ) {
    assertEquals(isValidWindow(bad), false, bad);
    // 回退默认 00:30-08:30 后仍可判定：北京 03:00 在内、12:00 在外。
    assertInside(cst(2026, 11, 13, 3, 0), bad);
    assertOutside(cst(2026, 11, 13, 12, 0), bad);
  }
  assertEquals(isValidWindow("22:00-06:00"), true);
  assertEquals(isValidWindow("00:30-08:30"), true);
});
