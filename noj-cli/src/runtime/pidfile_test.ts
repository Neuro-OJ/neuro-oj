import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import { pidPath, readPid, removePid, writePid } from "./pidfile.ts";

Deno.test("writePid/readPid/removePid 往返", async () => {
  const dir = await makeTempDir();
  const runDir = `${dir}/run`;
  await writePid(runDir, "server", 4242);
  assertEquals(pidPath(runDir, "server"), `${runDir}/server.pid`);
  assertEquals(await readPid(runDir, "server"), 4242);
  await removePid(runDir, "server");
  assertEquals(await readPid(runDir, "server"), null);
});

Deno.test("readPid: 缺失/非法内容返回 null", async () => {
  const dir = await makeTempDir();
  assertEquals(await readPid(`${dir}/run`, "nope"), null);
  await Deno.mkdir(`${dir}/run`);
  await Deno.writeTextFile(`${dir}/run/bad.pid`, "not-a-number");
  assertEquals(await readPid(`${dir}/run`, "bad"), null);
});
