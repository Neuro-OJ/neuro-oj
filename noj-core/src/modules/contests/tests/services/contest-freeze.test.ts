import { assertEquals } from "jsr:@std/assert@^1";
import { getContestFreezeWindow } from "../../services/contest-ranking.ts";

Deno.test("contest freeze: 按结束前时长计算 UTC 冻结起点", () => {
  const window = getContestFreezeWindow({
    end_time: "2026-09-06T12:00:00.000Z",
    freeze_start_time: null,
    freeze_duration_seconds: 900,
  });
  assertEquals(window.start, "2026-09-06T11:45:00.000Z");
  assertEquals(window.end, "2026-09-06T12:00:00.000Z");
});

Deno.test("contest freeze: 显式 ISO 起点优先且统一为 UTC", () => {
  const window = getContestFreezeWindow({
    end_time: "2026-09-06T12:00:00+00:00",
    freeze_start_time: "2026-09-06T19:30:00+08:00",
    freeze_duration_seconds: 0,
  });
  assertEquals(window.start, "2026-09-06T11:30:00.000Z");
});

Deno.test("contest freeze: 时长为 0 表示关闭封榜", () => {
  assertEquals(
    getContestFreezeWindow({
      end_time: "2026-09-06T12:00:00.000Z",
      freeze_start_time: null,
      freeze_duration_seconds: 0,
    }).start,
    null,
  );
});
