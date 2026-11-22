import { makeTempDir } from "../testing/helpers.ts";
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
  const dir = await makeTempDir();
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

// ── 2026-09-21 修复：stream() 把 stderr 设为 piped 却从不消费 ──
// 触发条件：子进程向 stderr 写入超过内核管道缓冲（Linux 约 64 KiB）。
// 实际可达：`noj-cli logs --follow` / `judge logs --follow` 的子进程是
// `docker compose ... logs --follow`，多服务时会向 stderr 写告警/进度。
Deno.test("realRunner.stream: 子进程大量 stderr 输出不会死锁", async () => {
  const lines: string[] = [];
  const r = realRunner();
  // 先写 256 KiB stderr，再向 stdout 输出一行。
  const script = [
    'python3 -c "',
    "import sys",
    "sys.stderr.write('E' * (256*1024))",
    "sys.stderr.flush()",
    "print('done')\"",
  ].join("\n");
  const run = r.stream!("sh", ["-c", script], (l) => lines.push(l));
  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => resolve(-1), 10_000);
  });
  const code = await Promise.race([run, timeout]);
  assertEquals(
    code,
    0,
    "stream 应在子进程退出后返回退出码；超时(-1)说明 stderr 管道未被排空导致死锁",
  );
  assertEquals(lines.includes("done"), true);
});

Deno.test("realRunner.run: 超时后终止子进程并返回 124（无句柄泄漏）", async () => {
  const started = Date.now();
  const out = await realRunner().run("sleep", ["10"], { timeoutMs: 100 });
  const elapsed = Date.now() - started;
  assertEquals(out.code, 124);
  assertEquals(out.stderr, "command timed out");
  assertEquals(
    elapsed < 3000,
    true,
    `应在 timeoutMs 后迅速返回，实得 ${elapsed}ms`,
  );
});

Deno.test("realRunner.pipe: 二进制字节经无 shell 管道无损传输", async () => {
  const dir = await makeTempDir();
  try {
    const src = `${dir}/in.bin`;
    const dst = `${dir}/out.bin`;
    const payload = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0xc0, 0x50]);
    await Deno.writeFile(src, payload);
    const r = realRunner();
    const res = await r.pipe!(
      { cmd: "cat", args: [src] },
      { cmd: "sh", args: ["-c", `cat > "$1"`, "pipe-out", dst] },
    );
    assertEquals(res.firstCode, 0);
    assertEquals(res.secondCode, 0);
    assertEquals([...await Deno.readFile(dst)], [...payload]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("realRunner.pipe: 捕获上游失败退出码与 stderr", async () => {
  const r = realRunner();
  const res = await r.pipe!(
    { cmd: "sh", args: ["-c", "echo upstream-boom >&2; exit 4"] },
    { cmd: "cat", args: [] },
  );
  assertEquals(res.firstCode, 4);
  assertEquals(res.secondCode, 0);
  assertEquals(res.firstStderr.includes("upstream-boom"), true);
});

Deno.test("realRunner.pipe: 下游提前退出时不阻塞上游写端且快速返回", async () => {
  const r = realRunner();
  const started = Date.now();
  const res = await r.pipe!(
    { cmd: "sleep", args: ["10"] },
    { cmd: "sh", args: ["-c", "echo downstream-early >&2; exit 9"] },
  );
  const elapsed = Date.now() - started;
  assertEquals(res.secondCode, 9);
  assertEquals(res.secondStderr.includes("downstream-early"), true);
  assertEquals(
    elapsed < 3000,
    true,
    `下游提前退出时应在 3s 内终止上游并结束，实得 ${elapsed}ms`,
  );
});
