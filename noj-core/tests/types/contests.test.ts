/**
 * 竞赛类型/配置纯函数测试（类 Kaggle 赛制）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  isValidContestConfig,
  isValidContestType,
} from "../../src/types/contests.ts";

Deno.test("contests: 仅允许 kaggle 赛制", () => {
  assertEquals(isValidContestType("kaggle"), true);
  assertEquals(isValidContestType("icpc"), false);
  assertEquals(isValidContestType("ioi"), false);
  assertEquals(isValidContestType("oi"), false);
});

Deno.test("contests: submission_limits 配置合法", () => {
  assertEquals(
    isValidContestConfig("kaggle", { submission_limits: { "p1": 15 } }),
    true,
  );
  assertEquals(isValidContestConfig("kaggle", {}), true);
  assertEquals(
    isValidContestConfig("kaggle", { submission_limits: { "p1": 0 } }),
    false,
  );
  assertEquals(
    isValidContestConfig("kaggle", { submission_limits: "bad" }),
    false,
  );
});
