import { makeTempDir } from "../testing/helpers.ts";
import { assertEquals } from "@std/assert";
import { followLogFile, logPath, readRecentLog } from "./logfile.ts";

Deno.test("logPath: 返回 run/logs/<component>.log", () => {
  assertEquals(
    logPath("/opt/neuro-oj/run", "server"),
    "/opt/neuro-oj/run/logs/server.log",
  );
});

Deno.test("readRecentLog: 读末尾 maxBytes 字节", async () => {
  const dir = await makeTempDir();
  const p = `${dir}/a.log`;
  await Deno.writeTextFile(p, "0123456789");
  assertEquals(await readRecentLog(p, 4), "6789");
});

Deno.test("readRecentLog: 文件缺失返回空串", async () => {
  const dir = await makeTempDir();
  assertEquals(await readRecentLog(`${dir}/nope.log`, 100), "");
});

Deno.test("followLogFile: 从末尾开始轮询新内容并按行回调", async () => {
  const dir = await makeTempDir();
  const p = `${dir}/a.log`;
  await Deno.writeTextFile(p, "old-line\n");
  const seen: string[] = [];
  const signal = { aborted: false };
  const done = followLogFile(p, (l) => seen.push(l), signal);
  // 追加两行后等待回调
  await Deno.writeTextFile(p, "new-1\nnew-2\n", { append: true });
  await new Promise((r) => setTimeout(r, 50));
  signal.aborted = true;
  await done;
  assertEquals(seen, ["new-1", "new-2"]);
});
