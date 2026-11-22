import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import { isFile } from "./fs.ts";

Deno.test("isFile: 存在的文件返回 true", async () => {
  const dir = await makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "x");
  assertEquals(await isFile(p), true);
});

Deno.test("isFile: 不存在/目录返回 false", async () => {
  const dir = await makeTempDir();
  assertEquals(await isFile(`${dir}/nope.txt`), false);
  assertEquals(await isFile(dir), false);
});
