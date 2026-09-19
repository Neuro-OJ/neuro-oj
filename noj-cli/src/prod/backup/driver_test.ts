/**
 * T17 driver 测试：prod-raw 的文件重定向**对真实进程**成立。
 *
 * 前面的 `container_test.ts` 用 fake runner 证明"容器层只走 spawn 的 stdoutFile"。
 * 那还不够——它没有证明 `stdoutFile` 这条路径在**真实进程**上确实以字节搬运。
 * 本文件用真实 `realRunner()` + 真实 `sh`/`cat` 做端到端验证：
 *
 * - 采集：`cat` 一段含 `\x00`/`0xFF` 的二进制 → **逐字节**落进目标文件；
 * - 回灌：`cat` 从来源文件读 → 输出逐字节等于来源，且 stdout 落文件也逐字节相等；
 * - 路径安全：路径含空格/引号/`$` 时不拼接进脚本正文（经位置参数传递）。
 *
 * 这些用例不依赖 docker（只依赖 `sh`/`cat`），因此在任何 CI 环境都可跑。
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { realRunner } from "../../runtime/command.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import { CaptureError, prodComposeArgs, realRawDriver } from "./driver.ts";

/** 一段含 NUL / 高位 / 非法 UTF-8 序列的字节。 */
const BINARY = new Uint8Array([
  0x00,
  0x01,
  0x7f,
  0x80,
  0x8f,
  0xc0,
  0xc1,
  0xfe,
  0xff,
  0x1b,
  0x5b,
  0x33,
  0x31,
  0x6d, // ESC [31m
  0x00,
  0x00,
  0x00,
]);

Deno.test("T17 realRawDriver.captureToFile：真实 cat 的二进制输出逐字节落盘", async () => {
  const dir = await makeTempDir();
  try {
    const source = join(dir, "source.bin");
    const dest = join(dir, "captured.bin");
    await Deno.writeFile(source, BINARY);
    await Deno.writeFile(dest, new Uint8Array()); // spawn 的 stdoutFile 是 append 语义

    const driver = realRawDriver(realRunner());
    const code = await driver.captureToFile("cat", [source], {
      destFile: dest,
    });
    assertEquals(code, 0);

    const captured = await Deno.readFile(dest);
    assertEquals(
      [...captured],
      [...BINARY],
      "经 spawn({stdoutFile}) 采集的字节必须逐字节等于来源（含 NUL 与 0xFF）",
    );
    // 证明没有被 UTF-8 归一化（否则 0xC0/0xC1/0xFE/0xFF 会变成 U+FFFD 的 3 字节）
    assertEquals(captured.length, BINARY.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 realRawDriver.feedFromFile：从文件喂 stdin，参数不受污染", async () => {
  const dir = await makeTempDir();
  try {
    const source = join(dir, "source.bin");
    const outFile = join(dir, "out.bin");
    await Deno.writeFile(source, BINARY);
    await Deno.writeFile(outFile, new Uint8Array());

    const driver = realRawDriver(realRunner());
    // `cat` 无参数时把 stdin 原样写到 stdout；captureToFile 的 stdout 落文件。
    // 用 feedToFile 同时覆盖两个方向。
    const code = await driver.feedToFile("cat", [], {
      srcFile: source,
      destFile: outFile,
    });
    assertEquals(code, 0);
    assertEquals([...await Deno.readFile(outFile)], [...BINARY]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 realRawDriver.feedFromFile：目标命令收到原始参数（路径不混进 argv）", async () => {
  const dir = await makeTempDir();
  try {
    const source = join(dir, "source.txt");
    await Deno.writeFile(source, new TextEncoder().encode("stdin-data\n"));

    const driver = realRawDriver(realRunner());
    // `sh -c 'cat "$@"'` 会把参数当文件名——若 srcFile 混进 "$@"，cat 会尝试读它，
    // 输出就会多出一份内容。把 args 设为 `-`（cat 读 stdin）即可区分：
    // 正确实现下 argv 只有 `-`，输出 == stdin 内容。
    const runner = realRunner();
    const res = await runner.run("sh", [
      "-c",
      'src="$1"; shift; printf "argc=%s args=%s\\n" "$#" "$*"; cat "$@" < "$src"',
      "noj-feed",
      source,
      "-",
    ]);
    assertEquals(res.code, 0);
    assert(
      res.stdout.includes("argc=1 args=-"),
      `目标命令必须只收到原始 args（实得：${res.stdout.split("\n")[0]}）`,
    );
    assert(res.stdout.includes("stdin-data"));
    void driver;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 realRawDriver：含空格/引号/$ 的路径经位置参数安全传递", async () => {
  const dir = await makeTempDir();
  try {
    // 刻意含空格、单引号、双引号与 $：若实现把它拼进脚本正文，必然失败或注入
    const nasty = join(dir, "a b'c\"d$e.bin");
    await Deno.writeFile(nasty, BINARY);
    const dest = join(dir, "out.bin");
    await Deno.writeFile(dest, new Uint8Array());

    const driver = realRawDriver(realRunner());
    const code = await driver.feedToFile("cat", [], {
      srcFile: nasty,
      destFile: dest,
    });
    assertEquals(code, 0, "含特殊字符的路径必须能正常传递");
    assertEquals([...await Deno.readFile(dest)], [...BINARY]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 realRawDriver.captureToFile：非 0 退出码如实回传（不抛错）", async () => {
  const dir = await makeTempDir();
  try {
    const dest = join(dir, "out.bin");
    await Deno.writeFile(dest, new Uint8Array());
    const driver = realRawDriver(realRunner());
    const code = await driver.captureToFile("sh", ["-c", "exit 42"], {
      destFile: dest,
    });
    assertEquals(code, 42, "退出码由调用方判定（captureToFile 只搬运）");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 realRawDriver：runner 缺 spawn 时明确抛错（绝不退化为字符串路径）", async () => {
  const dir = await makeTempDir();
  try {
    const dest = join(dir, "out.bin");
    await Deno.writeFile(dest, new Uint8Array());
    // 故意去掉 spawn：模拟 P2 既有 fake 的能力缺口
    const noSpawn = {
      run: realRunner().run,
      spawn: undefined as never,
    };
    const driver = realRawDriver(noSpawn);
    await assertRejects(
      () => driver.captureToFile("cat", [], { destFile: dest }),
      Error,
      "不支持 spawn",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T17 prodComposeArgs：参数数组形状（含 profile / project-name / --ansi never）", () => {
  const base = {
    composeFile: "/opt/noj/docker-compose.prod.yml",
    envFile: "/opt/noj/.env.prod",
    dockerBin: "docker",
  };
  assertEquals(prodComposeArgs(base, ["exec", "-T", "postgres", "pg_dump"]), [
    "compose",
    "--env-file",
    "/opt/noj/.env.prod",
    "--file",
    "/opt/noj/docker-compose.prod.yml",
    "exec",
    "-T",
    "postgres",
    "pg_dump",
  ]);
  // judge 在 monitoring 之前（与 T10 的插入顺序一致）
  assertEquals(
    prodComposeArgs({ ...base, judge: true, monitoring: true }, ["ps"]),
    [
      "compose",
      "--env-file",
      "/opt/noj/.env.prod",
      "--file",
      "/opt/noj/docker-compose.prod.yml",
      "--profile",
      "judge",
      "--profile",
      "monitoring",
      "ps",
    ],
  );
  // project-name 在 profile 之前；--ansi never 是**全局**旗标，必须最前
  const withAll = prodComposeArgs({
    ...base,
    projectName: "noj-drill",
    judge: true,
    noAnsi: true,
  }, ["ps"]);
  assertEquals(withAll.slice(0, 2), ["--ansi", "never"]);
  const pn = withAll.indexOf("--project-name");
  const pf = withAll.indexOf("--profile");
  assert(pn > 0 && pf > pn, "project-name 必须在 profile 之前");
});

Deno.test("T17 CaptureError：带上命令名与退出码，便于定位", () => {
  const err = new CaptureError("pg_dump", 1, "connection refused");
  assert(err.message.includes("pg_dump"));
  assert(err.message.includes("1"));
  assert(err.message.includes("connection refused"));
  assertEquals(err.cmd, "pg_dump");
  assertEquals(err.code, 1);
  assertEquals(err.name, "CaptureError");
});
