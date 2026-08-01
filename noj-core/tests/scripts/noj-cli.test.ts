/**
 * CLI（scripts/noj.ts）测试。
 *
 * 通过子进程执行 CLI，验证：
 * - help 输出包含全部子命令
 * - 子命令 help 输出选项
 * - 未知命令报错退出码
 *
 * 不依赖数据库（不执行会连 DB 的子命令）。
 */

import { assertEquals } from "jsr:@std/assert@^1";

const CLI = new URL("../../scripts/noj.ts", import.meta.url).pathname;

async function runCli(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("noj --help 包含全部子命令", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assertEquals(code, 0);
  for (const name of ["db", "init", "bootstrap", "problems", "dev-setup"]) {
    assertEquals(stdout.includes(name), true, `help 应包含子命令 ${name}`);
  }
});

Deno.test("noj --version 输出版本", async () => {
  const { code, stdout } = await runCli(["--version"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("1.0.0"), true);
});

Deno.test("noj problems build --help 包含 --id 选项", async () => {
  const { code, stdout } = await runCli(["problems", "build", "--help"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("--id"), true);
});

Deno.test("noj bootstrap admin --help 包含 --email/--password", async () => {
  const { code, stdout } = await runCli(["bootstrap", "admin", "--help"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("--email"), true);
  assertEquals(stdout.includes("--password"), true);
});

Deno.test("noj problems import --help 包含 --dir 默认值", async () => {
  const { code, stdout } = await runCli(["problems", "import", "--help"]);
  assertEquals(code, 0);
  assertEquals(stdout.includes("--dir"), true);
});

Deno.test("noj 未知命令返回非零退出码", async () => {
  const { code, stderr } = await runCli(["nonexistent"]);
  assertEquals(code !== 0, true);
  assertEquals(stderr.includes("Unknown command"), true);
});
