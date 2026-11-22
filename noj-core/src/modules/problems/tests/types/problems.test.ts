import { assertEquals } from "jsr:@std/assert@^1";
import { DIFFICULTIES, isValidDifficulty } from "../../types/problems.ts";

Deno.test({
  name: "DIFFICULTIES 常量包含预期值",
  fn: () => {
    assertEquals(DIFFICULTIES, ["easy", "medium", "hard"]);
  },
});

Deno.test({
  name: "isValidDifficulty 返回 true 对合法值",
  fn: () => {
    assertEquals(isValidDifficulty("easy"), true);
    assertEquals(isValidDifficulty("medium"), true);
    assertEquals(isValidDifficulty("hard"), true);
  },
});

Deno.test({
  name: "isValidDifficulty 返回 false 对非法值",
  fn: () => {
    assertEquals(isValidDifficulty(""), false);
    assertEquals(isValidDifficulty("impossible"), false);
    assertEquals(isValidDifficulty("EASY"), false);
    assertEquals(isValidDifficulty("medium "), false);
  },
});
