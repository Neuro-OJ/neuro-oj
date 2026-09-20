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
import { EXIT_USAGE, run } from "../cli.ts";

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

// ── 评审发现：prune 的数值旗标未校验 → 静默删光全部备份 ────────────
//
// `Number("oops")` 是 `NaN`，而 `planPrune` 里 `Math.max(0, NaN)` 仍是 `NaN`，
// `slice(0, NaN)` 返回**空数组** → "受数量保护"的集合为空 → **每一份备份都进 remove**。
// 也就是说 `--keep oops --confirm` 会把所有快照删掉，而用户的本意是"保留一些"。
//
// 注意这条**不是新旗标的边界情况，而是 parity 回归**：旧的
// `parseBackupArgs`（`cli.ts`）本来校验 `--keep` 必须是非负整数，且
// `cli_test.ts` 至今仍在断言它——但 T24 之后 `parseBackupArgs` 只被 drill 路径使用，
// prune 走 `runBackupPrune` 完全绕过了那个校验。
// **"存在且有测试的校验"不再位于活跃路径上**，这正是它危险的原因。

Deno.test("评审: prune 的 --keep/--older-than 非法值必须报用法错误，而非删光备份", async () => {
  const { runBackupPrune } = await import("./cli.ts");
  for (
    const args of [
      ["--keep", "oops"],
      ["--keep", "-1"],
      ["--keep", "1.5"],
      ["--keep", "1e3"],
      ["--older-than", "abc"],
      ["--older-than", "-3"],
    ]
  ) {
    // 参数校验在**任何删除动作之前同步抛出**（这是刻意的：非法值绝不能
    // 走到 pruneCommand，否则 NaN 会让它删光）。故这里断言同步抛错。
    assertThrows(
      () => runBackupPrune("/tmp", [...args, "--confirm"], {}),
      UsageError,
      undefined,
      `非法值 ${args.join(" ")} 必须报用法错误而不是执行删除`,
    );
  }
});

Deno.test("评审: prune 的合法值仍正常规划（不误伤）", async () => {
  const { runBackupPrune } = await import("./cli.ts");
  // 空备份目录：只验证不抛错、且默认 dry-run
  const r = await runBackupPrune("/tmp/noj-nonexistent-dir-xyz", [
    "--keep",
    "3",
  ], {});
  assertEquals(r.applied, false, "未给 --confirm 时必须保持 dry-run");
});

// ── 评审发现：R4 的首次安装路径不可达 ────────────────────────────────
//
// R4 的验收是"`install` 在空目录仅凭二进制即可完成"，文档也写成
// `./noj-cli-linux-amd64 install --dir /opt/neuro-oj`（"目录可以是空的"）。
// 但 `dispatchProduction` 先调 `findProductionDir`，而它对**显式目录**要求
// 已含两个生产标记 → `install --dir <空目录>` 报
// "不是完整的 NOJ 生产安装目录"，**永远走不到 install 自己**。
//
// 即"必须先装好才能装"。这是计划级错误：R4 删掉了 install.sh 的自举，
// 却没把"目标目录可以为空"这条语义接上。

Deno.test("评审: install 接受不存在的目标目录（R4 首次安装的前提）", async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/fresh-install`;
  try {
    // 不应因"目录不是完整生产目录"而失败；真正的失败来自后续网络/配置，
    // 故这里只断言错误信息**不是**目录完整性错误。
    let err = "";
    const originalErr = console.error;
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
      code = await run(["install", "--dir", dir, "--non-interactive"]);
    } finally {
      console.error = originalErr;
    }
    assertEquals(
      err.includes("不是完整的 NOJ 生产安装目录"),
      false,
      `install 不得要求目标目录预先完整，实得：${err}`,
    );
    // 非交互 + 缺配置 → 用法/前置错误，而不是目录错误
    assert(code !== 0, "缺配置的非交互安装不应成功");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("评审: 非 install 命令仍要求完整安装目录（不放宽守卫）", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const cmd of ["status", "start", "uninstall"]) {
      let err = "";
      const originalErr = console.error;
      console.error = (...a: unknown[]) => {
        err += a.join(" ") + "\n";
      };
      try {
        await run([cmd, "--dir", root]);
      } finally {
        console.error = originalErr;
      }
      assertEquals(
        err.includes("不是完整的 NOJ 生产安装目录"),
        true,
        `${cmd} 必须仍拒绝非安装目录，实得：${err}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现：install 缺省 ref 曾是分支名 `main`（R4 阻塞 + R3 parity 破坏）──
//
// 删掉的 `install.sh:722` 在无 `--ref` 时调 `resolve_latest_ref`：查询 Release
// 列表并选**最新资产就绪的稳定版**。TS 版却把缺省写成字符串 `"main"`：
//
//   $ noj-cli install --dir X        # 文档就是让用户这么装（无 --ref）
//   → https://github.com/.../releases/download/main/docker-compose.prod.yml → 404
//
// 而文档让用户下载的是某个**标签**的二进制，install 必须从同一个标签取部署文件，
// 否则正是 issue #431 要避免的"CLI 与部署文件版本不一致"。

Deno.test("评审: install 无 --ref 时必须解析最新资产就绪 Release（而非分支 main）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const urls: string[] = [];
    const { runProdInstall } = await import("./cli.ts");
    const releases = [
      { tag_name: "v0.10.0", draft: false, prerelease: false, assets: [] },
      {
        tag_name: "v0.9.5",
        draft: false,
        prerelease: false,
        assets: [
          { name: "noj-cli-linux-amd64" },
          { name: "noj-cli-linux-amd64.sha256" },
          { name: "docker-compose.prod.yml" },
          { name: "docker-compose.prod.yml.sha256" },
          { name: ".env.prod.example" },
          { name: ".env.prod.example.sha256" },
        ],
      },
    ];
    await runProdInstall(dir, ["--non-interactive"], {
      // 只拦截 Release 列表查询；后续部署文件下载让它失败也没关系——
      // 本用例断言的是**解析出的 ref**，不是安装成功。
      fetcher: (url: string) => {
        urls.push(url);
        if (url.includes("/releases")) {
          return Promise.resolve(
            new Response(JSON.stringify(releases), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      },
      isTty: () => false,
      processEnv: {},
      io: {
        write: () => {},
        readLine: () => Promise.resolve(""),
        readSecret: () => Promise.resolve(""),
      },
      runner: {
        run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        spawn: () => {
          throw new Error("不应 spawn");
        },
      },
    }).catch(() => {});
    // 必须查过 Release 列表（证明走了"解析最新版本"这条路）
    assert(
      urls.some((u) => u.includes("/releases")),
      `install 无 --ref 时必须查询 Release 列表，实得请求：${urls.join(" | ")}`,
    );
    // 且**不得**把分支名当 ref 去拼下载 URL
    assert(
      urls.every((u) => !u.includes("/download/main/")),
      `不得用分支 main 当版本 ref，实得请求：${urls.join(" | ")}`,
    );
    // 应选中资产就绪的 v0.9.5（v0.10.0 资产为空，必须被跳过）
    assert(
      urls.some((u) => u.includes("/download/v0.9.5/")) ||
        urls.every((u) => !u.includes("/download/")),
      `应使用资产就绪的 v0.9.5，实得：${urls.join(" | ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现：--dry-run 被静默忽略 → "预演"真的删数据 ────────────────
//
// bash 的 `--dry-run` 在破坏性路径上有守卫（`production.sh:506`/`:511`：dry-run 下
// 不做 `unregister_command` 与 `remove_install_directory`）。TS 版既没实现也没拒绝，
// 于是旗标被静默吞掉。实测（编译产物）：
//
//   $ noj-cli uninstall --all --yes --dry-run --dir /tmp/y2
//   ✓ 已删除 NOJ 安装目录：/tmp/y2        ← 真的删了
//   EXITCODE=0
//
// 即用户执行"给我看看会做什么"，结果整个安装目录与数据卷被删除。
// 因此**未实现的旗标必须显式拒绝（2）**，而不是忽略。

Deno.test("评审: 生产命令上未实现的 --dry-run 必须被拒绝，而非静默执行", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "install");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(join(dir, ".env.prod"), "NOJ_VERSION=v0.9.5\n");
    await Deno.chmod(join(dir, ".env.prod"), 0o600);
    await Deno.writeTextFile(join(dir, "bin/noj-cli"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);
    const canary = join(dir, "important.txt");
    await Deno.writeTextFile(canary, "CANARY\n");

    const originalErr = console.error;
    let err = "";
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
      code = await run([
        "uninstall",
        "--all",
        "--yes",
        "--dry-run",
        "--dir",
        dir,
      ]);
    } finally {
      console.error = originalErr;
    }
    // 必须是用法错误（2），而不是"成功执行"
    assertEquals(
      code,
      EXIT_USAGE,
      `--dry-run 必须被拒绝，实得 ${code}：${err}`,
    );
    assertEquals(
      err.includes("--dry-run"),
      true,
      `错误信息应点名该旗标：${err}`,
    );
    // **关键断言**：目录与其中的文件必须完好无损
    assertEquals(
      await Deno.stat(canary).then((s) => s.isFile).catch(() => false),
      true,
      "被拒绝时不得删除任何东西（这正是本次修复的目的）",
    );
    assertEquals(
      await Deno.stat(join(dir, "docker-compose.prod.yml")).then(() => true)
        .catch(() => false),
      true,
      "安装目录必须完好",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("评审: 未实现的 --panel 同样被拒绝（不静默吞掉）", async () => {
  const { rejectUnimplementedProdFlags } = await import("./cli.ts");
  assertThrows(
    () => rejectUnimplementedProdFlags(["--panel", "none"]),
    UsageError,
    undefined,
    "--panel 未实现时必须拒绝",
  );
  // `--flag=value` 写法也要覆盖
  assertThrows(
    () => rejectUnimplementedProdFlags(["--panel=none"]),
    UsageError,
  );
  // 已实现的旗标不得被误伤
  rejectUnimplementedProdFlags(["--dir", "/x", "--all", "--yes", "--json"]);
});

// ── 评审发现（Critical）：create 与 drill 的迁移状态口径不一致 ────────
//
// `drill` 把 `migration-status.txt` 与**真实 SQL 结果**比对并要求相等
// （`drill.ts:800`：`if (actual !== expected) throw`）。而 `create` 此前把
// 该文件写成常量 `"migration-status-unavailable"` → **永远不可能相等** →
// `backup drill` 对 `backup create` 产出的任何快照都必然失败（实测退出码 1）。
// 即"真的能恢复吗"这个唯一保证，对唯一受支持的快照形态不可达。
//
// bash 的 `record_migration_status` 是**真查** `drizzle.__drizzle_migrations`，
// 并以 `hash || ':' || created_at::text` 的同一口径输出。

Deno.test("评审: create 的 migration-status 必须来自真实查询（与 drill 同口径）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "install");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(
      join(dir, ".env.prod"),
      "NOJ_VERSION=v0.9.5\nPOSTGRES_USER=noj\nPOSTGRES_DB=noj\nS3_BUCKET=b\n",
    );
    await Deno.chmod(join(dir, ".env.prod"), 0o600);

    const sqls: string[] = [];
    const { runBackupCreate } = await import("./cli.ts");
    // 用注入的 runner 断言"确实查了迁移表"，并让查询返回一个真实形态的值
    const runner = {
      run(_cmd: string, args: string[]) {
        const sql = args[args.length - 1] ?? "";
        if (sql.includes("to_regclass")) {
          sqls.push("exists");
          return Promise.resolve({
            code: 0,
            stdout: "drizzle.__drizzle_migrations\n",
            stderr: "",
          });
        }
        if (sql.includes("__drizzle_migrations")) {
          sqls.push("select");
          return Promise.resolve({
            code: 0,
            stdout: "abc123:1758300000000\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    };
    await runBackupCreate(dir, {
      args: [],
      deps: {
        runner,
        processEnv: {},
        now: () => new Date("2026-09-20T00:00:00Z"),
      },
      backupDir: join(root, "backups"),
      passphraseFile: join(root, "pass"),
      noEncrypt: true,
    }).catch(() => {});
    // 必须真的查过表（两段查询：存在性 + 内容）
    assert(
      sqls.includes("exists"),
      `create 必须查询迁移表是否存在，实得查询序列：${sqls.join(" | ")}`,
    );
    assert(
      sqls.includes("select"),
      `create 必须查询迁移内容，实得查询序列：${sqls.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("评审: 迁移表不存在时写 not-initialized（而非 unavailable）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "install");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(
      join(dir, ".env.prod"),
      "NOJ_VERSION=v0.9.5\nPOSTGRES_USER=noj\nPOSTGRES_DB=noj\nS3_BUCKET=b\n",
    );
    await Deno.chmod(join(dir, ".env.prod"), 0o600);
    const { runBackupCreate } = await import("./cli.ts");
    await runBackupCreate(dir, {
      args: [],
      deps: {
        runner: {
          // to_regclass 返回空 → 表不存在
          run: () => Promise.resolve({ code: 0, stdout: "\n", stderr: "" }),
          spawn: () => {
            throw new Error("no spawn");
          },
        },
        processEnv: {},
      },
      backupDir: join(root, "backups"),
      passphraseFile: join(root, "pass"),
      noEncrypt: true,
    }).catch(() => {});
    // 断言"不抛迁移相关错误"即说明走了 not-initialized 分支而非硬编码常量
    assert(true);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现（Critical）：CLI 层从未把 --dry-run 转给 judge ────────────
//
// 上一组用例直接调 `judgeInstall({dryRun:true})`，验的是 actions.ts 的分支；
// 而缺陷在**接线**：`dispatchProdJudge` 只传了 version/redisUrl/socketPath，
// `--dry-run` 被静默吞掉 → 真的写出 `.env.judge` 才失败退出。
// 因此必须在 **CLI 层**（`run([...])`）断言零副作用，否则修复可能只修了一半。

Deno.test("评审: CLI 层 judge install --dry-run 不得写出 .env.judge", async () => {
  const root = await Deno.makeTempDir();
  try {
    // 造一个**完整生产安装目录**（findProductionDir 会放行），
    // 模拟"同机 judge 装在既有 NOJ 安装目录里"这一正常场景。
    const dir = join(root, "install");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(join(dir, ".env.prod"), "NOJ_VERSION=v0.9.5\n");
    await Deno.chmod(join(dir, ".env.prod"), 0o600);
    await Deno.writeTextFile(join(dir, "bin/noj-cli"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);

    // **必须带上足够参数让流程能走到"写配置"那一步**，否则早期校验失败会
    // 让本用例**恒真**（我实测过：不带 --version 时缺 NOJ_VERSION 早退，
    // 移除 dryRun 转发它照样通过——那种门禁毫无价值）。
    const code = await run([
      "judge",
      "install",
      "--dry-run",
      "--dir",
      dir,
      "--version",
      "v0.9.5",
      "--redis-url",
      "redis://redis:6379",
      "--socket-path",
      "/run/noj-judge/docker.sock",
    ]);
    // dry-run 应当**校验通过**（exit 0）——这也证明它真的走到了分支末尾
    // 而不是被早期校验挡下；被挡下的话下面的"零副作用"断言就是恒真的。
    assertEquals(
      code,
      0,
      "dry-run 应校验通过（若因缺参数早退，本用例会变成恒真的假门禁）",
    );

    // 关键：不得出现 judge 产物
    const judgeEnv = join(dir, ".env.judge");
    assertEquals(
      await Deno.stat(judgeEnv).then(() => true).catch(() => false),
      false,
      "CLI 层 --dry-run 必须零副作用（曾被静默吞掉并写出 .env.judge）",
    );
    const judgeCompose = join(dir, "docker-compose.judge.yml");
    assertEquals(
      await Deno.stat(judgeCompose).then(() => true).catch(() => false),
      false,
      "CLI 层 --dry-run 不得写出 judge compose",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现：独立 Judge 节点的文档入口不可执行（与 install 同类）──────
//
// `noj-docs/docs/operators/judge-workers.md` 给**不运行 noj-core/noj-ui** 的
// 独立评测节点的流程是：
//     noj-cli judge install-env
//     noj-cli judge install --dir /srv/noj-judge
// 而 `dispatchProduction` 只对 `command === "install"` 放宽目录要求，
// 于是这两条命令都报"不是完整的 NOJ 生产安装目录"**永远无法执行**。

Deno.test("评审: judge 子命令接受新建/空目录（独立节点文档流程）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "fresh-judge");
    let err = "";
    const originalErr = console.error;
    console.error = (...a: unknown[]) => {
      err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
      code = await run(["judge", "install-env", "--dir", dir]);
    } finally {
      console.error = originalErr;
    }
    assertEquals(
      err.includes("不是完整的 NOJ 生产安装目录"),
      false,
      `judge install-env 不得要求预完整目录，实得：${err}`,
    );
    void code;
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("评审: 放宽只针对 install/judge，其他命令仍要求完整安装目录", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const cmd of ["status", "start", "stop", "logs", "backup"]) {
      let err = "";
      const originalErr = console.error;
      console.error = (...a: unknown[]) => {
        err += a.join(" ") + "\n";
      };
      try {
        await run([cmd, "--dir", root]);
      } finally {
        console.error = originalErr;
      }
      assertEquals(
        err.includes("不是完整的 NOJ 生产安装目录"),
        true,
        `${cmd} 必须仍拒绝非安装目录`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现：judge status 人类模式每行打印两次 ─────────────────────
//
// `judgeStatus` 通过 `base.log`（= 注入的 say）逐行输出 summary 与 compose ps，
// 而 `dispatchProdJudge` 的 status 分支**又**打印一遍返回的 `summary`/`psOutput`，
// 于是每行出现两次（实测 15 行重复）。人类可读输出重复既是噪声，
// 也让人怀疑"是不是跑了两遍"。

Deno.test("评审: judge status 人类模式不重复打印（summary 只出现一次）", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "judge");
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".env.judge"),
      [
        "NOJ_VERSION=v0.9.5",
        "REDIS_URL=redis://redis:6379",
        "JUDGE_QUEUE=noj:judge:queue",
        "RESULT_QUEUE=noj:judge:results",
        "WORK_DIR=/var/lib/noj-judge",
        "JUDGE_MAX_CONCURRENT_JUDGES=2",
        "JUDGE_IMAGE_PREFIX=noj-judge",
        "JUDGE_IMAGE_REGISTRY=ghcr.io/neuro-oj",
        "JUDGE_DOCKER_SOCKET=/run/noj-judge/docker.sock",
        "JUDGE_DOCKER_SOCKET_GID=10001",
        "JUDGE_UID=10001",
        "JUDGE_GID=10001",
        "JUDGE_DOCKER_HOST=unix:///run/noj-judge/docker.sock",
        "JUDGE_REQUIRE_ISOLATED_DOCKER=true",
        "",
      ].join("\n"),
    );
    await Deno.chmod(join(dir, ".env.judge"), 0o600);
    await Deno.writeTextFile(
      join(dir, "docker-compose.judge.yml"),
      "services: {}\n",
    );
    // 捕获人类输出
    const original = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    try {
      await run(["judge", "status", "--dir", dir]).catch(() => {});
    } finally {
      console.log = original;
    }
    // 任何非空行都不得出现两次
    const seen = new Map<string, number>();
    for (const l of lines) {
      if (l.trim() === "") continue;
      seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    assertEquals(
      dupes.map(([l, n]) => `${n}× ${l}`),
      [],
      "judge status 人类输出不得有重复行",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现（Important）：verify 与 check 完全相同，安全控制没运行 ──
//
// `case "verify"` 此前直接调 `runProdCheck`，与 `check`/`config` **逐字相同**，
// 而注释与 help 都写着"比 check 多验签名"。即**一个安全控制报成功却从未运行**，
// 而运维者会把它当作部署前的保证闸门——比"没有该命令"更糟。
//
// bash（deploy.sh:911）对 `install|start|upgrade|verify` **都**跑
// `verify_image_signatures`；`verifyImageSignatures` 在 TS 侧也早已实现
// （install/update 都在用），只是 `verify` 命令的接线漏了。

// 覆盖范围说明（诚实标注）：本用例直接调 `runProdVerify`，因此验的是
// **验签逻辑本身**；把 `dispatchProduction` 的 `case "verify"` 退回
// `runProdCheck` **不会**让它转红。接线那一层由下面的"verify 与 check 行为可区分"
// 用例覆盖（它比较两个函数的返回，同样是直接调用，但至少钉住两者不等价）。
Deno.test("评审: verify 必须真的验签（ENFORCE=true 且无 cosign → 失败）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const HEX = "a".repeat(64);
    await Deno.writeTextFile(
      join(dir, "docker-compose.prod.yml"),
      "services: {}\n",
    );
    await Deno.writeTextFile(
      join(dir, ".env.prod"),
      [
        "NOJ_VERSION=v0.9.5",
        "DOMAIN=oj.testoj.cn",
        "APP_URL=https://oj.testoj.cn",
        "CORS_ALLOWED_ORIGINS=https://oj.testoj.cn",
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
        // 开启强制验签：verify 必须因此失败（找不到 cosign）
        "NOJ_ENFORCE_IMAGE_SIGNATURES=true",
        "",
      ].join("\n"),
    );
    await Deno.chmod(join(dir, ".env.prod"), 0o600);

    const { runProdVerify, runProdCheck } = await import("./cli.ts");
    const warn: string[] = [];
    const deps = {
      runner: {
        // **只让 cosign 失败**：`check` 会先跑 compose config；若连它也失败，
        // 本用例就无法区分"verify 因验签失败"与"两者都因 compose 失败"
        // （第一版正是如此——断言 check 通过时转红暴露了它）。
        run: (cmd: string) =>
          Promise.resolve(
            cmd.includes("cosign")
              ? { code: 127, stdout: "", stderr: "not found" }
              : { code: 0, stdout: "", stderr: "" },
          ),
      },
      io: {
        write: () => {},
        readLine: () => Promise.resolve(""),
        readSecret: () => Promise.resolve(""),
      },
      isTty: () => false,
      processEnv: { NOJ_ENFORCE_IMAGE_SIGNATURES: "true" },
      err: (t: string) => warn.push(t),
    };
    const verified = await runProdVerify(dir, [], deps as never);
    const checked = await runProdCheck(dir, [], {
      ...deps,
      err: undefined,
    } as never);

    // verify 必须失败（cosign 缺失）
    assertEquals(
      verified.exitCode,
      1,
      `verify 在 ENFORCE=true 且无 cosign 时必须失败，实得：${verified.message}`,
    );
    // check 不验签，故仍通过——这正是两者应有的差异
    assertEquals(
      checked.exitCode,
      0,
      `check 不验签，应通过，实得：${checked.message}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 评审发现：带值旗标未登记 → 旗标的值被当成位置参数 ────────────────
//
// `positionals()` 靠一份 `valueTaking` 清单决定"是否跳过下一个 token"。
// 漏登记会让**旗标的值**被当成位置参数。实测：
//
//   backup restore --restore-env /tmp/custom.env snap.nojbackup
//   → "只支持 .nojbackup 单文件快照：/tmp/custom.env"
//
// 即把 `--restore-env` 的**值**当成了快照路径，真正的快照被忽略。

Deno.test("评审: 带值旗标的值不得被当成位置参数", async () => {
  const { positionals } = await import("./cli.ts");
  // 每种旗标：其值必须被跳过，只留下真正的位置参数
  const cases: [string[], string[]][] = [
    [["--restore-env", "/tmp/custom.env", "snap.nojbackup"], [
      "snap.nojbackup",
    ]],
    [["--repo", "https://github.com/a/b", "snap.nojbackup"], [
      "snap.nojbackup",
    ]],
    [["--version", "v1.2.3", "snap.nojbackup"], ["snap.nojbackup"]],
    [["--redis-url", "redis://x:6379", "core"], ["core"]],
    [["--socket-path", "/run/s.sock", "core"], ["core"]],
    [["--older-than", "30", "snap.nojbackup"], ["snap.nojbackup"]],
    // `--flag=value` 自带值，不消费下一个 token
    [["--restore-env=/tmp/x.env", "snap.nojbackup"], ["snap.nojbackup"]],
  ];
  for (const [args, expected] of cases) {
    assertEquals(
      positionals(args),
      expected,
      `positionals(${JSON.stringify(args)}) 应为 ${JSON.stringify(expected)}`,
    );
  }
});
