/**
 * T24 测试：生产命令的原生接线与 R1 门禁。
 *
 * 本套测试的最高价值项是 **R1 门禁**：断言 `noj-cli/src` 内**零** bash / 脚本调用。
 * 那是一条"只要有人贴回一段旧代码就会失效"的性质，靠 review 不可靠——
 * 实测过它的价值：T23 之后 `production.ts:112` 是唯一的违例，本门禁直接指出它。
 *
 * 其余用例覆盖接线层自己的职责（参数解析、退出码、`--json` 纯净），
 * 命令语义本身由 `prod/*_test.ts` 各自覆盖。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  flagValue,
  hasFlag,
  hasJson,
  parseProdArgs,
  positionals,
} from "./cli.ts";
import { UsageError } from "../util/args.ts";

// ---------------- R1 门禁 ----------------

Deno.test("R1 门禁: src 内零 bash / 生产脚本调用", async () => {
  const root = new URL(".", import.meta.url);
  const offenders: string[] = [];
  // 遍历 src 下的全部 .ts（排除测试自身）
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith("_test.ts")) continue;
      const text = await Deno.readTextFile(child);
      // **只查代码，不查注释**：注释里引用 `deploy.sh:679` 这类"出处"是必要的
      // 可追溯信息（R3 parity 的对照表就靠它）。门禁要抓的是"真的去执行脚本"，
      // 因此剥掉三种注释形态：整行 `//`、JSDoc 续行 `*`、以及行尾 `// …`。
      const code = text
        .split("\n")
        .map((l) => {
          const t = l.trim();
          if (t.startsWith("*") || t.startsWith("//")) return "";
          // 单行 JSDoc（`/** … */`）整体是注释——`steps.ts` 里大量存在
          // （`/** \`deploy.sh:906\` 的 fail 逐字 */`），剥掉它们才不会把
          // "引用出处"误判成"调用脚本"。
          if (t.startsWith("/**") && t.endsWith("*/")) return "";
          if (t.startsWith("/*")) return "";
          const idx = l.indexOf("//");
          return idx === -1 ? l : l.slice(0, idx);
        })
        .join("\n");
      for (
        const needle of [
          'Deno.Command("bash"',
          "production.sh",
          "deploy.sh",
          "backup.sh",
          "restore-drill.sh",
          "backup-schedule.sh",
          "judge-install.sh",
        ]
      ) {
        if (code.includes(needle)) {
          offenders.push(`${entry.name}: ${needle}`);
        }
      }
    }
  };
  await walk(root);
  assertEquals(
    offenders,
    [],
    `src 内不得再调用 bash / 生产脚本（R1）：\n${offenders.join("\n")}`,
  );
});

// ---------------- 参数解析 ----------------

Deno.test("parseProdArgs: 拆出 --dir 与其两种写法", () => {
  assertEquals(parseProdArgs([]), { dir: undefined, rest: [] });
  assertEquals(parseProdArgs(["--dir", "/opt/noj"]), {
    dir: "/opt/noj",
    rest: [],
  });
  assertEquals(parseProdArgs(["--dir=/opt/noj", "--latest"]), {
    dir: "/opt/noj",
    rest: ["--latest"],
  });
  // 位置参数与其它旗标原样保留
  assertEquals(parseProdArgs(["--dir", "/o", "core", "--follow"]), {
    dir: "/o",
    rest: ["core", "--follow"],
  });
});

Deno.test("parseProdArgs: 缺值报用法错误；--install-dir 明确拒绝", () => {
  assertThrows(() => parseProdArgs(["--dir"]), UsageError, "需要一个目录路径");
  assertThrows(() => parseProdArgs(["--dir", "--latest"]), UsageError);
  assertThrows(() => parseProdArgs(["--dir="]), UsageError);
  // Tier 3 的旗标不得被生产命令静默吞掉
  assertThrows(
    () => parseProdArgs(["--install-dir", "/opt"]),
    UsageError,
    "--install-dir",
  );
});

Deno.test("flagValue/hasFlag/hasJson: 旗标读取", () => {
  assertEquals(
    flagValue(["--passphrase-file", "/p"], "--passphrase-file"),
    "/p",
  );
  assertEquals(flagValue(["--passphrase-file=/p"], "--passphrase-file"), "/p");
  assertEquals(flagValue([], "--x"), undefined);
  assertThrows(() => flagValue(["--x"], "--x"), UsageError, "需要一个值");
  assertThrows(() => flagValue(["--x="], "--x"), UsageError);

  assertEquals(hasFlag(["--follow"], "--follow", "-f"), true);
  assertEquals(hasFlag(["-f"], "--follow", "-f"), true);
  assertEquals(hasFlag([], "--follow"), false);
  assertEquals(hasJson(["--json"]), true);
  assertEquals(hasJson([]), false);
});

Deno.test("positionals: 跳过选项及其值，但保留服务名", () => {
  // 带值的选项必须跳过它的值，否则服务名会被漏掉或选项值被当服务名
  assertEquals(positionals(["core", "--dir", "/o"]), ["core"]);
  assertEquals(positionals(["--dir=/o", "core"]), ["core"]);
  assertEquals(positionals(["--tail", "50", "core", "ui"]), ["core", "ui"]);
  // `--` 之后一律视为位置参数
  assertEquals(positionals(["--", "--weird-name"]), ["--weird-name"]);
  // 布尔选项不消费下一个参数
  assertEquals(positionals(["--follow", "core"]), ["core"]);
});

// ---------------- 接线：调原生实现而非 spawn ----------------

Deno.test("接线: status 走原生实现（注入 runner 收到 compose ps，且无 bash）", async () => {
  const dir = await makeInstallDir();
  try {
    const calls: { cmd: string; args: string[] }[] = [];
    const { runProdStatus } = await import("./cli.ts");
    const result = await runProdStatus(dir, [], {
      runner: {
        run(cmd: string, args: string[]) {
          calls.push({ cmd, args: [...args] });
          // `compose ps` 返回一个空表（表示未运行）
          return Promise.resolve({
            code: 0,
            stdout: "NAME  IMAGE  STATUS\n",
            stderr: "",
          });
        },
        spawn() {
          throw new Error("不应 spawn");
        },
      },
      io: { stdout: () => {}, stderr: () => {}, jsonMode: false },
      isTty: () => false,
      processEnv: {},
    } as never);
    assertEquals(result.exitCode, 0, result.error ?? "");
    // 关键：调用的是 docker compose，且**没有任何** bash / 脚本
    assert(calls.length > 0, "必须真的调用了命令");
    assertEquals(
      calls.some((c) => c.cmd === "bash"),
      false,
      "不得 spawn bash（R1）",
    );
    assert(
      calls.some((c) => c.cmd === "docker" && c.args.includes("compose")),
      "应调用 docker compose",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("接线: uninstall 在非 TTY 下明确报错且零副作用（T15 契约保持）", async () => {
  const dir = await makeInstallDir();
  try {
    const calls: { cmd: string; args: string[] }[] = [];
    const { runProdUninstall } = await import("./cli.ts");
    const result = await runProdUninstall(dir, ["--all"], {
      runner: {
        run(cmd: string, args: string[]) {
          calls.push({ cmd, args: [...args] });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        spawn() {
          throw new Error("不应 spawn");
        },
      },
      io: {
        write: () => {},
        readLine: () => Promise.resolve(""),
        readSecret: () => Promise.resolve(""),
      },
      isTty: () => false,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1, "非 TTY 且未 --yes 必须失败");
    assertStringIncludes(result.error ?? "", "--yes");
    // **零副作用**：确认阶段就该返回，不得有任何 compose 调用
    assertEquals(calls.length, 0, "确认失败必须零副作用");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("接线: update 未接线备份时明确失败（T16 的注入点已接上真实实现）", async () => {
  const dir = await makeInstallDir();
  try {
    const { runProdUpdate } = await import("./cli.ts");
    // 备份 inject 已由接线层提供；这里让 docker 调用失败以验证"备份失败 → 中止升级"
    const calls: string[] = [];
    const result = await runProdUpdate(dir, [], {
      runner: {
        run(cmd: string, args: string[]) {
          calls.push([cmd, ...args].join(" "));
          // `pg_dump` 失败 → 备份失败 → 升级必须中止
          if (args.join(" ").includes("pg_dump")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "pg_dump failed",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        spawn() {
          throw new Error("不应 spawn");
        },
      },
      io: { stdout: () => {}, stderr: () => {}, jsonMode: false },
      isTty: () => false,
      processEnv: {},
      processState: undefined,
    } as never);
    // 升级失败（备份没过）→ 退出码 1；且**不得**执行 pull/up
    assertEquals(result.exitCode, 1, result.error ?? "");
    assertEquals(
      calls.some((c) => c.includes(" pull")),
      false,
      "备份失败后不得拉取镜像",
    );
    assertEquals(
      calls.some((c) => c.includes("up -d")),
      false,
      "备份失败后不得启动服务",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("接线: backup list 走原生实现且不创建备份", async () => {
  const dir = await makeInstallDir();
  try {
    const { runBackupList } = await import("./cli.ts");
    const before = await dirFingerprint(join(dir, "backups"));
    const result = await runBackupList(dir, [], {});
    assertEquals(result.entries.length, 0);
    assertEquals(
      await dirFingerprint(join(dir, "backups")),
      before,
      "list 不得改变备份目录内容",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("接线: backup schedule status 未安装 → 退出码 1 且提示可读", async () => {
  const dir = await makeInstallDir();
  try {
    const { runBackupSchedule } = await import("./cli.ts");
    const result = await runBackupSchedule(dir, ["status"], {
      runner: {
        run(_cmd: string, args: string[]) {
          // `crontab -l` 非 0（用户没有 crontab —— 常态）
          return Promise.resolve({
            code: args[0] === "-l" ? 1 : 0,
            stdout: "",
            stderr: "",
          });
        },
        spawn() {
          throw new Error("不应 spawn");
        },
      },
      processEnv: {},
      out: () => {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.message, "未安装");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("接线: backup schedule 非法子命令 → 用法错误", async () => {
  const dir = await makeInstallDir();
  try {
    const { runBackupSchedule } = await import("./cli.ts");
    await assertRejects(
      () =>
        runBackupSchedule(dir, ["bogus"], { processEnv: {}, out: () => {} }),
      UsageError,
      "install/status/remove",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------- 辅助 ----------------

/** 造一个满足生产安装目录特征的最小目录。 */
async function makeInstallDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "docker-compose.prod.yml"),
    "services: {}\n",
  );
  // 必须是一份**通过 checkRequiredValues** 的完整配置——否则原生实现会在
  // 前置校验阶段就返回，测试就测不到后面的 compose 调用。
  const HEX = "a".repeat(64);
  await Deno.writeTextFile(
    join(dir, ".env.prod"),
    [
      "NOJ_VERSION=v0.9.5",
      "DOMAIN=oj.test-oj.cn",
      "APP_URL=https://oj.test-oj.cn",
      "CORS_ALLOWED_ORIGINS=https://oj.test-oj.cn",
      "TRUSTED_PROXIES=172.28.0.0/16",
      `POSTGRES_PASSWORD=${HEX}`,
      `REDIS_PASSWORD=${HEX}`,
      "MINIO_ROOT_USER=nojminio123456",
      `MINIO_ROOT_PASSWORD=${HEX}`,
      "S3_ACCESS_KEY=nojs3123456",
      `S3_SECRET_KEY=${HEX}`,
      "S3_BUCKET=noj-support-packages",
      "S3_ENDPOINT=http://minio:9000",
      "STORAGE_PROVIDER=s3",
      `JWT_SECRET=${HEX}`,
      `TFA_ENCRYPTION_KEY=${HEX}`,
      `NOJ_LLM_SERVICE_TOKEN=${HEX}`,
      `NOJ_LLM_STORE_KEY=${HEX}`,
      "EMAIL_PROVIDER=disabled",
      "JUDGE_ENABLED=false",
      "NOJ_ENFORCE_IMAGE_SIGNATURES=false",
      "POSTGRES_USER=noj",
      "POSTGRES_DB=noj",
      "",
    ].join("\n"),
  );
  await Deno.chmod(join(dir, ".env.prod"), 0o600);
  return dir;
}

/** 目录指纹（清单 + 每项大小）：用于断言"零副作用"。 */
async function dirFingerprint(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const st = await Deno.stat(join(dir, entry.name));
      out.push(`${entry.name}:${st.size}`);
    }
  } catch {
    return [];
  }
  return out.sort();
}
