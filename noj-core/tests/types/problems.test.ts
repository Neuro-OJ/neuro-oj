import { assertEquals } from "jsr:@std/assert@^1";
import {
  DIFFICULTIES,
  isValidDifficulty,
  isValidProblemType,
  PROBLEM_TYPES,
} from "../../src/types/problems.ts";

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

Deno.test({
  name: "PROBLEM_TYPES 常量包含预期值",
  fn: () => {
    assertEquals(PROBLEM_TYPES, ["U", "P"]);
  },
});

Deno.test({
  name: "isValidProblemType 返回 true 对合法值",
  fn: () => {
    assertEquals(isValidProblemType("U"), true);
    assertEquals(isValidProblemType("P"), true);
  },
});

Deno.test({
  name: "isValidProblemType 返回 false 对非法值",
  fn: () => {
    assertEquals(isValidProblemType(""), false);
    assertEquals(isValidProblemType("u"), false);
    assertEquals(isValidProblemType("p"), false);
    assertEquals(isValidProblemType("A"), false);
  },
});
