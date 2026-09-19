import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { findProductionDir } from "./production.ts";

Deno.test("生产目录支持显式路径、祖先目录及 PATH 软链接；错误目录不回退", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "安装目录");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    // 保留一个真实子目录，供「从子目录向上查找」的断言使用
    await Deno.mkdir(join(dir, "scripts"), { recursive: true });
    // 生产目录特征 = .env.prod + docker-compose.prod.yml（production.sh 已非特征）
    await Deno.writeTextFile(join(dir, ".env.prod"), "");
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
