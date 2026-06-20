import { assertEquals } from "jsr:@std/assert@^1";
import { scoreFromDb, scoreToDb } from "../../src/types/index.ts";

Deno.test("scoreToDb/scoreFromDb 整分", () => {
  assertEquals(scoreToDb(100), 10000);
  assertEquals(scoreFromDb(10000), 100);
});

Deno.test("scoreToDb/scoreFromDb 小数", () => {
  assertEquals(scoreToDb(99.5), 9950);
  assertEquals(scoreFromDb(9950), 99.5);
});

Deno.test("scoreToDb/scoreFromDb 零分", () => {
  assertEquals(scoreToDb(0), 0);
  assertEquals(scoreFromDb(0), 0);
});

Deno.test("scoreToDb/scoreFromDb 满分", () => {
  assertEquals(scoreToDb(10.0), 1000);
  assertEquals(scoreFromDb(1000), 10);
});

Deno.test("scoreToDb 四舍五入", () => {
  assertEquals(scoreToDb(10.005), 1001);
  assertEquals(scoreToDb(10.004), 1000);
});
