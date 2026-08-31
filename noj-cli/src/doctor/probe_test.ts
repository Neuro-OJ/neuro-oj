import { assertEquals } from "@std/assert";
import { realProbe } from "./probe.ts";

Deno.test("realProbe 暴露当前 os/arch", () => {
  const probe = realProbe();
  assertEquals(probe.os, Deno.build.os);
  assertEquals(probe.arch, Deno.build.arch);
});

Deno.test("realProbe.run 执行命令并返回退出码与输出", async () => {
  const probe = realProbe();
  const r = await probe.run("printf", ["hello"]);
  assertEquals(r.code, 0);
  assertEquals(r.stdout, "hello");
});
