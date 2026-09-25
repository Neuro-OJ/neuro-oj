import { assertEquals } from "@std/assert";
import { VERSION } from "./mod.ts";

Deno.test("mod 导出版本号 0.10.1-alpha.2", () => {
  assertEquals(VERSION, "0.10.1-alpha.2");
});
