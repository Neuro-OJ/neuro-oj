import { assertEquals } from "@std/assert";
import { findDeployDir } from "./find_deploy_dir.ts";

Deno.test("从子目录向上找到含 noj-deploy.json 的父目录", async () => {
  const dir = await Deno.makeTempDir();
  const nested = `${dir}/a/b/c`;
  await Deno.mkdir(nested, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, "{}");
  assertEquals(findDeployDir(nested), dir);
});

Deno.test("目录内直接存在 noj-deploy.json 时返回该目录", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, "{}");
  assertEquals(findDeployDir(dir), dir);
});

Deno.test("向上找不到时返回 null", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(findDeployDir(dir), null);
});
