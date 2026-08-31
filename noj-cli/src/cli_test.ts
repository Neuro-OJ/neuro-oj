import { assertEquals } from "@std/assert";
import { dispatchCommand, printHelp, run } from "./cli.ts";
import type { CommandContext } from "./cli.ts";

const ctx: CommandContext = { cwd: "/tmp", deployDir: null };

Deno.test("printHelp 包含全部顶层命令", () => {
  const help = printHelp();
  for (const c of ["doctor", "deploy", "maintain", "run-server", "version"]) {
    assertEquals(help.includes(c), true, `help 应包含 ${c}`);
  }
});

Deno.test("version stub 返回 0", async () => {
  assertEquals(await dispatchCommand("version", [], ctx), 0);
});

Deno.test("doctor/deploy/maintain/run-server stub 返回 0", async () => {
  assertEquals(await dispatchCommand("doctor", [], ctx), 0);
  assertEquals(await dispatchCommand("deploy", [], ctx), 0);
  assertEquals(await dispatchCommand("maintain", [], ctx), 0);
  assertEquals(await dispatchCommand("run-server", [], ctx), 0);
});

Deno.test("deploy 子命令 init/up/down/restart/status 返回 0", async () => {
  for (const sub of ["init", "up", "down", "restart", "status"]) {
    assertEquals(
      await dispatchCommand("deploy", [sub], ctx),
      0,
      `deploy ${sub}`,
    );
  }
});

Deno.test("maintain 子命令返回 0", async () => {
  for (
    const sub of ["logs", "backup", "restore", "verify", "reset", "config"]
  ) {
    assertEquals(
      await dispatchCommand("maintain", [sub], ctx),
      0,
      `maintain ${sub}`,
    );
  }
});

Deno.test("未知命令返回 1", async () => {
  assertEquals(await dispatchCommand("bogus", [], ctx), 1);
});

Deno.test("run 识别 --help 返回 0", async () => {
  assertEquals(await run(["--help"]), 0);
});

Deno.test("run 识别 version 返回 0", async () => {
  assertEquals(await run(["version"]), 0);
});
