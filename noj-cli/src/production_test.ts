import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { findProductionDir, parseProductionArgs } from "./production.ts";
import { run } from "./cli.ts";

Deno.test("生产参数保留空格和 shell 字符，不把参数拼成命令", () => {
  assertEquals(
    parseProductionArgs([
      "--dir",
      "/tmp/部署 目录",
      "--env-file",
      "/tmp/a $(whoami).env",
      "--latest",
    ]),
    {
      dir: "/tmp/部署 目录",
      forwarded: ["--env-file", "/tmp/a $(whoami).env", "--latest"],
    },
  );
  assertThrows(() => parseProductionArgs(["--dir", "--latest"]));
  assertThrows(() => parseProductionArgs(["--dir="]));
});

Deno.test("生产目录支持显式路径、祖先目录及 PATH 软链接；错误目录不回退", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "安装目录");
    await Deno.mkdir(join(dir, "scripts/deploy"), { recursive: true });
    await Deno.mkdir(join(dir, "bin"));
    await Deno.writeTextFile(join(dir, "scripts/deploy/production.sh"), "");
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(join(dir, "bin/noj-cli"), "");
    await Deno.symlink(join(dir, "bin/noj-cli"), join(root, "cli-link"));
    assertEquals(await findProductionDir(dir), dir);
    assertEquals(await findProductionDir(undefined, join(dir, "scripts")), dir);
    assertEquals(
      await findProductionDir(undefined, root, join(root, "cli-link")),
      await Deno.realPath(dir),
    );
    await assertRejects(() => findProductionDir(root, dir), Error, "不是完整");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("生产 CLI 在不完整生产目录返回非零", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts/deploy"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    assertEquals(
      await run(["status", "--dir", dir, "--env-file", "a $(whoami).env"]),
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
