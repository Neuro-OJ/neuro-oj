import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import { fileExists } from "./fs.ts";

Deno.test("fileExists: 存在的文件返回 true", async () => {
  const dir = await makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "x");
  assertEquals(await fileExists(p), true);
});

Deno.test("fileExists: 不存在/目录返回 false", async () => {
  const dir = await makeTempDir();
  assertEquals(await fileExists(`${dir}/nope.txt`), false);
  assertEquals(await fileExists(dir), false);
});
