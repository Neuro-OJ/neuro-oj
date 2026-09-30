import { assertEquals } from "@std/assert";
import { VERSION } from "./mod.ts";

Deno.test("mod 导出版本号 0.10.3-alpha.1", () => {
  assertEquals(VERSION, "0.10.3-alpha.1");
});
