import { assertEquals } from "@std/assert";
import { realRunner } from "./command.ts";

Deno.test("realRunner.run 执行命令并返回退出码与输出", async () => {
  const r = realRunner().run("printf", ["hello"], { env: {} });
  const out = await r;
  assertEquals(out.code, 0);
  assertEquals(out.stdout, "hello");
});

Deno.test("realRunner.run: stdin 传入子进程", async () => {
  const r = realRunner();
  const out = await r.run("cat", [], { stdin: "hello-stdin" });
  assertEquals(out.code, 0);
  assertEquals(out.stdout, "hello-stdin");
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

Deno.test("realRunner.spawn: stdoutFile 捕获子进程输出", async () => {
  const dir = await Deno.makeTempDir();
  const log = `${dir}/out.log`;
  const handle = realRunner().spawn({
    cmd: "sh",
    args: ["-c", "echo hello-captured"],
    cwd: ".",
    env: {},
    stdoutFile: log,
  });
  const code = await handle.wait();
  assertEquals(code, 0);
  const text = await Deno.readTextFile(log);
  assertEquals(text.includes("hello-captured"), true);
});

Deno.test("realRunner.stream: 逐行回调并返回退出码", async () => {
  const lines: string[] = [];
  const r = realRunner();
  const code = await r.stream!(
    "sh",
    ["-c", "printf 'a\\nb\\n'"],
    (l) => lines.push(l),
  );
  assertEquals(code, 0);
  assertEquals(lines, ["a", "b"]);
});
