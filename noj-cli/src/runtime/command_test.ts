import { assertEquals } from "@std/assert";
import { realRunner } from "./command.ts";

Deno.test("realRunner.run 执行命令并返回退出码与输出", async () => {
  const r = realRunner().run("printf", ["hello"], { env: {} });
  const out = await r;
  assertEquals(out.code, 0);
  assertEquals(out.stdout, "hello");
});

Deno.test("realRunner.spawn 产生可用 PID 并可 wait", async () => {
  const handle = realRunner().spawn({
    cmd: "sh",
    args: ["-c", "exit 7"],
    cwd: ".",
    env: {},
  });
  assertEquals(typeof handle.pid, "number");
  const code = await handle.wait();
  assertEquals(code, 7);
});
