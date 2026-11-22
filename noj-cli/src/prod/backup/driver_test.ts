/**
 * driver 测试：prod-raw 的文件重定向**对真实进程**成立。
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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { realRunner } from "../../runtime/command.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import {
  CaptureError,
  createProdPayloadOps,
  prodComposeArgs,
  realRawDriver,
} from "./driver.ts";

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

Deno.test("realRawDriver.captureToFile：真实 cat 的二进制输出逐字节落盘", async () => {
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

Deno.test("realRawDriver.feedFromFile：从文件喂 stdin，参数不受污染", async () => {
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

Deno.test("realRawDriver.feedFromFile：目标命令收到原始参数（路径不混进 argv）", async () => {
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

Deno.test("realRawDriver：含空格/引号/$ 的路径经位置参数安全传递", async () => {
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

Deno.test("realRawDriver.captureToFile：非 0 退出码如实回传（不抛错）", async () => {
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

Deno.test("prodComposeArgs：参数数组形状（含 profile / project-name / --ansi never）", () => {
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
  // judge 在 monitoring 之前
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
  // **`--ansi` 必须紧跟 `compose` 之后**：它是 compose 的旗标。
  // 旧断言把 `["--ansi","never"]` 钉在数组**最前**（即 `compose` 之前），
  // 实测那会得到 `docker --ansi never compose …` → `unknown flag: --ansi`。
  // 也就是说：**这条断言在固化一个真实的 bug**。
  assertEquals(withAll[0], "compose");
  assertEquals(withAll.slice(1, 3), ["--ansi", "never"]);
  // 再钉一次不变式：`--ansi` 之后才允许出现 `compose` 的子命令
  assert(
    withAll.indexOf("compose") < withAll.indexOf("--ansi"),
    "--ansi 必须在 compose 之后",
  );
  const pn = withAll.indexOf("--project-name");
  const pf = withAll.indexOf("--profile");
  assert(pn > 0 && pf > pn, "project-name 必须在 profile 之前");
});

Deno.test("CaptureError：带上命令名与退出码，便于定位", () => {
  const err = new CaptureError("pg_dump", 1, "connection refused");
  assert(err.message.includes("pg_dump"));
  assert(err.message.includes("1"));
  assert(err.message.includes("connection refused"));
  assertEquals(err.cmd, "pg_dump");
  assertEquals(err.code, 1);
  assertEquals(err.name, "CaptureError");
});

Deno.test("MinIO 镜像沿用采集数据库的独立 Compose 项目", async () => {
  const dir = await makeTempDir();
  try {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = {
      ...realRunner(),
      run(cmd: string, args: string[]) {
        calls.push({ cmd, args });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    };
    const compose = {
      composeFile: "/opt/noj/docker-compose.prod.yml",
      envFile: "/opt/noj/.env.prod",
      dockerBin: "/usr/local/bin/docker",
      projectName: "noj-backup-isolated",
      judge: true,
      noAnsi: true,
    };
    const ops = createProdPayloadOps({
      runner,
      driver: realRawDriver(runner),
      compose,
      env: { S3_BUCKET: "school-versions" },
    });
    await ops.minioMirror(join(dir, "minio"));
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.cmd, compose.dockerBin);
    const args = calls[0]!.args;
    const runIndex = args.indexOf("run");
    assertEquals(args.slice(0, runIndex), prodComposeArgs(compose, []));
    assertEquals(args.slice(runIndex), [
      "run",
      "--rm",
      "--no-deps",
      "--user",
      `${Deno.uid()}:${Deno.gid()}`,
      "--env",
      "MC_CONFIG_DIR=/tmp/noj-backup-mc",
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${join(dir, "minio")}:/backup:rw`,
      "minio-init",
      "-c",
      'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --preserve "local/school-versions" /backup',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tarZstEncrypt：有 pipe() 时流式直出，零中间 .tar.zst 且捕获两端失败", async () => {
  const dir = await makeTempDir();
  try {
    const piped: Array<{
      firstCmd: string;
      firstArgs: string[];
      secondCmd: string;
      secondArgs: string[];
    }> = [];
    let outcome = {
      firstCode: 0,
      secondCode: 0,
      firstStderr: "",
      secondStderr: "",
    };
    const runner = {
      ...realRunner(),
      pipe(
        first: { cmd: string; args: string[] },
        second: { cmd: string; args: string[] },
      ) {
        piped.push({
          firstCmd: first.cmd,
          firstArgs: [...first.args],
          secondCmd: second.cmd,
          secondArgs: [...second.args],
        });
        return Promise.resolve(outcome);
      },
    };
    const compose = {
      composeFile: "/opt/noj/docker-compose.prod.yml",
      envFile: "/opt/noj/.env.prod",
      dockerBin: "docker",
    };
    const ops = createProdPayloadOps({
      runner,
      driver: realRawDriver(runner),
      compose,
      env: {},
    });
    const staging = join(dir, "staging");
    await Deno.mkdir(staging, { recursive: true });
    const dest = join(dir, ".nojbackup-out.tmp");
    await ops.tarZstEncrypt!(staging, dest, 9, "/etc/pass");
    assertEquals(piped.length, 1);
    assertEquals(piped[0]!.firstCmd, "tar");
    assertEquals(
      piped[0]!.firstArgs,
      ["-I", "zstd -9", "-cf", "-", "-C", staging, "."],
    );
    assertEquals(piped[0]!.secondCmd, "gpg");
    assertEquals(
      piped[0]!.secondArgs.some((a) => a.endsWith(".tar.zst")),
      false,
      "流式管道不得引用中间 .tar.zst 文件",
    );
    const entries = await Array.fromAsync(Deno.readDir(dir));
    assertEquals(
      entries.some((e) => e.name.endsWith(".tar.zst")),
      false,
      "目录内不得产生任何中间 .tar.zst",
    );

    outcome = {
      firstCode: 2,
      secondCode: 0,
      firstStderr: "tar pipe err",
      secondStderr: "",
    };
    let errMsg = "";
    try {
      await ops.tarZstEncrypt!(staging, dest, 9, "/etc/pass");
    } catch (err) {
      errMsg = (err as Error).message;
    }
    assert(errMsg.includes("tar 打包") && errMsg.includes("tar pipe err"));

    outcome = {
      firstCode: 0,
      secondCode: 2,
      firstStderr: "",
      secondStderr: "gpg pipe err",
    };
    errMsg = "";
    try {
      await ops.tarZstEncrypt!(staging, dest, 9, "/etc/pass");
    } catch (err) {
      errMsg = (err as Error).message;
    }
    assert(errMsg.includes("gpg 加密") && errMsg.includes("gpg pipe err"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tarZstEncrypt：无 pipe() 时回退临时归档并在失败后清理", async () => {
  const dir = await makeTempDir();
  try {
    const runner = {
      run(cmd: string, _args: string[]) {
        if (cmd === "gpg") {
          return Promise.resolve({ code: 2, stdout: "", stderr: "gpg boom" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn() {
        throw new Error("no spawn");
      },
    };
    const ops = createProdPayloadOps({
      runner,
      driver: realRawDriver(runner),
      compose: {
        composeFile: "/opt/noj/docker-compose.prod.yml",
        envFile: "/opt/noj/.env.prod",
        dockerBin: "docker",
      },
      env: {},
    });
    const dest = join(dir, ".nojbackup-fallback.tmp");
    let errMsg = "";
    try {
      await ops.tarZstEncrypt!(join(dir, "staging"), dest, 9, "/etc/pass");
    } catch (err) {
      errMsg = (err as Error).message;
    }
    assert(errMsg.includes("gpg boom"));
    const entries = await Array.fromAsync(Deno.readDir(dir));
    assertEquals(
      entries.some((e) => e.name.endsWith(".tar.zst")),
      false,
      "失败后必须清理回退临时 .tar.zst",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
