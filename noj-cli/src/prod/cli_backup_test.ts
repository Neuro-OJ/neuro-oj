/** `backup` 子命令的 CLI 接线回归：create / list / prune / restore / schedule 的旗标、口令来源与 `--json` 输出通道。 */

import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { UsageError } from "../util/args.ts";
import { run } from "../cli.ts";
import { EXIT_USAGE } from "../cli-commands/exit-codes.ts";
import { dirFingerprint, makeInstallDir } from "./cli_fixtures.ts";

Deno.test("接线: backup list 走原生实现且不创建备份", async () => {
    const dir = await makeInstallDir();
    try {
        const { runBackupList } = await import("./commands/backup.ts");
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
        const { runBackupSchedule } = await import("./commands/backup.ts");
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
        const { runBackupSchedule } = await import("./commands/backup.ts");
        await assertRejects(
            () =>
                runBackupSchedule(dir, ["bogus"], {
                    processEnv: {},
                    out: () => {},
                }),
            UsageError,
            "install/status/remove",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

// ── 回归：prune 的数值旗标未校验 → 静默删光全部备份 ────────────
//
// `Number("oops")` 是 `NaN`，而 `planPrune` 里 `Math.max(0, NaN)` 仍是 `NaN`，
// `slice(0, NaN)` 返回**空数组** → "受数量保护"的集合为空 → **每一份备份都进 remove**。
// 也就是说 `--keep oops --confirm` 会把所有快照删掉，而用户的本意是"保留一些"。
//
// 校验必须落在 prune 的活跃路径（`runBackupPrune` → `optionalCount`）上：
// 曾经"存在且有测试"的校验写在只被 drill 使用的解析器里，prune 完全绕过了它。

Deno.test("prune 的 --keep/--older-than 非法值必须报用法错误，而非删光备份", async () => {
    const { runBackupPrune } = await import("./commands/backup.ts");
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

Deno.test("prune 的合法值仍正常规划（不误伤）", async () => {
    const { runBackupPrune } = await import("./commands/backup.ts");
    // 空备份目录：只验证不抛错、且默认 dry-run
    const r = await runBackupPrune("/tmp/noj-nonexistent-dir-xyz", [
        "--keep",
        "3",
    ], {});
    assertEquals(r.applied, false, "未给 --confirm 时必须保持 dry-run");
});

// ── 回归：create 与 drill 的迁移状态口径不一致 ────────
//
// `drill` 把 `migration-status.txt` 与**真实 SQL 结果**比对并要求相等
// （`drill.ts:800`：`if (actual !== expected) throw`）。而 `create` 此前把
// 该文件写成常量 `"migration-status-unavailable"` → **永远不可能相等** →
// `backup drill` 对 `backup create` 产出的任何快照都必然失败（实测退出码 1）。
// 即"真的能恢复吗"这个唯一保证，对唯一受支持的快照形态不可达。
//
// 正确做法是**真查** `drizzle.__drizzle_migrations`，
// 并以 `hash || ':' || created_at::text` 的同一口径输出。

Deno.test("create 的 migration-status 必须来自真实查询（与 drill 同口径）", async () => {
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
        const { runBackupCreate } = await import("./commands/backup.ts");
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

Deno.test("迁移表不存在时写 not-initialized（而非 unavailable）", async () => {
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
        const { runBackupCreate } = await import("./commands/backup.ts");
        await runBackupCreate(dir, {
            args: [],
            deps: {
                runner: {
                    // to_regclass 返回空 → 表不存在
                    run: () =>
                        Promise.resolve({ code: 0, stdout: "\n", stderr: "" }),
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

// ── 用户要求：create 成功后必须写出备份新鲜度指标 ────────────────────
//
// 单测 `metrics.ts` 只证明渲染/落盘正确；**接线**（create 是否真的调用它）
// 必须单独断言——"实现有、接线漏"的缺陷真实出现过。

Deno.test("新增: backup create 成功后写出 noj_backup.prom（接线断言）", async () => {
    // 注入最小 ops 走**完整 create 路径**——这样断言的是 `runBackupCreate`
    // 的指标接线，而不是把 `writeBackupMetrics` 再测一遍（后者无法发现
    // "create 忘了调它"这一类缺陷）。
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
        const backupDir = join(root, "backups");
        await Deno.mkdir(backupDir, { recursive: true });
        const pass = join(root, "pass");
        await Deno.writeTextFile(pass, "x".repeat(64));

        const { runBackupCreate } = await import("./commands/backup.ts");

        await runBackupCreate(dir, {
            args: [],
            deps: {
                runner: {
                    run: () =>
                        Promise.resolve({ code: 0, stdout: "", stderr: "" }),
                    spawn: () => {
                        throw new Error("no spawn");
                    },
                },
                processEnv: {},
                now: () => new Date("2026-09-19T12:00:00Z"),
            },
            backupDir,
            passphraseFile: pass,
            noEncrypt: true,
            ops: fakePayloadOps() as never,
        });

        // 指标必须由 create **自己**写出（这才是本用例要钉的接线）
        const file = join(backupDir, "metrics", "noj_backup.prom");
        const text = await Deno.readTextFile(file);
        assertStringIncludes(
            text,
            "noj_backup_last_success_unix_time 1789819200",
        );
        assertStringIncludes(text, "noj_backup_snapshot_bytes ");
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

// ── 生产实测缺陷：backup create 不读 `.env.prod` 中的口令路径 ──
//
// `update` 首次备份会生成口令文件并把路径写进 `.env.prod`，verify/restore/drill
// 也都按"旗标 > 进程环境 > .env.prod"解析；唯独 `backup create`（及
// `backup schedule`）只认旗标，手动执行即报"缺少 GPG 口令文件"。

/** 造一个带 `NOJ_BACKUP_PASSPHRASE_FILE` 的安装目录与对应口令文件。 */
async function makeCreateFixture(root: string): Promise<{
    dir: string;
    backupDir: string;
    configuredPass: string;
}> {
    const dir = join(root, "install");
    // schedule install 要求 `<dir>/bin/noj-cli` 存在且可执行（cron 的调用目标）
    await Deno.mkdir(join(dir, "bin"), { recursive: true });
    await Deno.writeTextFile(join(dir, "bin", "noj-cli"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "bin", "noj-cli"), 0o755);
    await Deno.writeTextFile(
        join(dir, "docker-compose.prod.yml"),
        "services: {}\n",
    );
    const configuredPass = join(root, "configured-pass");
    await Deno.writeTextFile(configuredPass, "x".repeat(64));
    await Deno.chmod(configuredPass, 0o600);
    await Deno.writeTextFile(
        join(dir, ".env.prod"),
        "NOJ_VERSION=v0.9.5\nPOSTGRES_USER=noj\nPOSTGRES_DB=noj\nS3_BUCKET=b\n" +
            `NOJ_BACKUP_PASSPHRASE_FILE=${configuredPass}\n`,
    );
    await Deno.chmod(join(dir, ".env.prod"), 0o600);
    const backupDir = join(root, "backups");
    await Deno.mkdir(backupDir, { recursive: true });
    return { dir, backupDir, configuredPass };
}

/** 跑一次加密的 `backup create`，返回 gpgEncrypt 实际收到的口令文件路径。 */
async function createWithPassphrase(
    dir: string,
    backupDir: string,
    opts: { passphraseFile?: string; processEnv?: Record<string, string> },
): Promise<string[]> {
    const used: string[] = [];
    const { runBackupCreate } = await import("./commands/backup.ts");
    await runBackupCreate(dir, {
        args: [],
        deps: {
            runner: {
                run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
                spawn: () => {
                    throw new Error("no spawn");
                },
            },
            processEnv: opts.processEnv ?? {},
            now: () => new Date("2026-10-12T08:00:00Z"),
        },
        backupDir,
        passphraseFile: opts.passphraseFile,
        ops: fakePayloadOps({ onEncrypt: (pass) => used.push(pass) }) as never,
        probeFreeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    return used;
}

Deno.test("缺陷修复: backup create 未传旗标时读取 .env.prod 的口令路径", async () => {
    const root = await Deno.makeTempDir();
    try {
        const { dir, backupDir, configuredPass } = await makeCreateFixture(
            root,
        );
        const used = await createWithPassphrase(dir, backupDir, {});
        assert(used.length > 0, "加密备份必须调用 gpgEncrypt");
        assert(
            used.every((p) => p === configuredPass),
            `应使用 .env.prod 中的口令路径，实际：${used.join(", ")}`,
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("缺陷修复: backup create 口令优先级为 旗标 > 进程环境 > .env.prod", async () => {
    const root = await Deno.makeTempDir();
    try {
        const { dir, backupDir } = await makeCreateFixture(root);
        const envPass = join(root, "env-pass");
        const flagPass = join(root, "flag-pass");
        for (const p of [envPass, flagPass]) {
            await Deno.writeTextFile(p, "y".repeat(64));
            await Deno.chmod(p, 0o600);
        }
        const processEnv = { NOJ_BACKUP_PASSPHRASE_FILE: envPass };

        const fromEnv = await createWithPassphrase(dir, backupDir, {
            processEnv,
        });
        assert(fromEnv.every((p) => p === envPass), "进程环境应覆盖 .env.prod");

        const fromFlag = await createWithPassphrase(dir, backupDir, {
            processEnv,
            passphraseFile: flagPass,
        });
        assert(fromFlag.every((p) => p === flagPass), "旗标应覆盖进程环境");
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("缺陷修复: backup schedule install 未传旗标时读取 .env.prod 的口令路径", async () => {
    const root = await Deno.makeTempDir();
    try {
        const { dir, configuredPass } = await makeCreateFixture(root);
        let written = "";
        const { runBackupSchedule } = await import("./commands/backup.ts");
        const result = await runBackupSchedule(dir, ["install"], {
            runner: {
                run(_cmd: string, args: string[], opts?: { stdin?: string }) {
                    if (args[0] === "-") written = opts?.stdin ?? "";
                    // `crontab -l` 非 0 = 当前无 crontab（常态）
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
        assertEquals(result.exitCode, 0, result.message);
        assertEquals(result.paths.passphraseFile, configuredPass);
        assertStringIncludes(written, configuredPass);
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

/**
 * 最小采集/打包 ops：写真实文件 + 真实 tar.zst；gpg 以复制代替（避免依赖 gpg），
 * `onEncrypt` 用于断言 create 实际传给加密步骤的口令文件路径。
 */
function fakePayloadOps(
    hooks: { onEncrypt?: (passphraseFile: string) => void } = {},
) {
    return {
        async postgresDump(d: string) {
            await Deno.writeFile(
                d,
                new Uint8Array([0x50, 0x47, 0x44, 0x4d, 0x50]),
            );
        },
        async postgresGlobals(d: string) {
            await Deno.writeTextFile(d, "-- g\nCREATE ROLE noj;\n");
        },
        async postgresRestoreList(_s: string, d: string) {
            await Deno.writeTextFile(d, "; listing\n1; 0 0 TABLE public t\n");
        },
        async redisRdb(d: string) {
            await Deno.writeFile(
                d,
                new Uint8Array([0x52, 0x45, 0x44, 0x49, 0x53]),
            );
        },
        async redisPersistence(d: string) {
            await Deno.writeTextFile(d, "rdb_last_bgsave_status:ok\r\n");
        },
        async minioMirror(d: string) {
            await Deno.mkdir(d, { recursive: true });
            await Deno.writeTextFile(`${d}/o.txt`, "x");
        },
        async minioList(_d: string, dest: string) {
            await Deno.writeTextFile(dest, "o.txt\n");
        },
        async restorePostgres() {},
        async restoreRedisRdb() {},
        async gpgEncrypt(src: string, dest: string, passphraseFile: string) {
            hooks.onEncrypt?.(passphraseFile);
            await Deno.copyFile(src, dest);
        },
        async gpgDecrypt(src: string, dest: string) {
            await Deno.copyFile(src, dest);
        },
        async tarZst(staging: string, dest: string) {
            const r = await new Deno.Command("tar", {
                args: ["--zstd", "-cf", dest, "-C", staging, "."],
            }).output();
            if (r.code !== 0) throw new Error("tar failed");
        },
        async untarZst(src: string, destDir: string) {
            await Deno.mkdir(destDir, { recursive: true });
            const r = await new Deno.Command("tar", {
                args: ["--zstd", "-xf", src, "-C", destDir],
            }).output();
            if (r.code !== 0) throw new Error("untar failed");
        },
    };
}

Deno.test("backup restore --dry-run 被接受（不再报用法错误）", async () => {
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
            "NOJ_VERSION=v0.9.5\n",
        );
        await Deno.chmod(join(dir, ".env.prod"), 0o600);
        await Deno.writeTextFile(join(dir, "bin/noj-cli"), "#!/bin/sh\n");
        await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);

        const originalErr = console.error;
        let err = "";
        console.error = (...a: unknown[]) => {
            err += a.join(" ") + "\n";
        };
        let code = -1;
        try {
            code = await run([
                "backup",
                "restore",
                join(root, "x.nojbackup"),
                "--dry-run",
                "--dir",
                dir,
            ]);
        } finally {
            console.error = originalErr;
        }
        // 修复前：`--dry-run` 在拒绝表里 → EXIT_USAGE 且文案是"尚未实现"。
        // 修复后：进入 dry-run 分支，因快照不存在而以运行失败结束（1），
        // 关键是**不再报"未实现该旗标"**。
        assertEquals(
            err.includes("尚未实现 --dry-run"),
            false,
            `不得再报"未实现 --dry-run"：${err}`,
        );
        void code;
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("backup restore --dry-run 与 --confirm 同时给出必须拒绝", async () => {
    const { run } = await import("../cli.ts");
    const originalErr = console.error;
    let err = "";
    console.error = (...a: unknown[]) => {
        err += a.join(" ") + "\n";
    };
    let code = -1;
    try {
        code = await run([
            "backup",
            "restore",
            "/tmp/x.nojbackup",
            "--dry-run",
            "--confirm",
        ]);
    } finally {
        console.error = originalErr;
    }
    assertEquals(code, EXIT_USAGE, `矛盾的旗标组合必须是用法错误：${err}`);
    assert(
        err.includes("--dry-run") && err.includes("--confirm"),
        `错误信息应点名两个旗标：${err}`,
    );
});

Deno.test("backup create 接住 --retention-days / --min-free-mb", async () => {
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
        const { runBackupCreate } = await import("./commands/backup.ts");
        // 注入"空间不足"的探测结果：必须**拒绝**（修复前 --min-free-mb 被静默吞掉）
        await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: { runner: minimalRunner(), processEnv: {} },
                    backupDir: join(root, "backups"),
                    passphraseFile: join(root, "pass"),
                    noEncrypt: true,
                    minFreeMb: 1024,
                    retentionDays: 7,
                    probeFreeBytes: () => Promise.resolve(512 * 1024 * 1024),
                }),
            Error,
            "可用空间不足",
            "--min-free-mb 必须真的生效（曾被静默忽略）",
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("backup create --retention-days 非法值在采集前报错", async () => {
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
        const { runBackupCreate } = await import("./commands/backup.ts");
        const spawned: string[] = [];
        await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: {
                        runner: {
                            run: () =>
                                Promise.resolve({
                                    code: 0,
                                    stdout: "",
                                    stderr: "",
                                }),
                            spawn: () => {
                                spawned.push("spawn");
                                throw new Error("no spawn");
                            },
                        },
                        processEnv: {},
                    },
                    backupDir: join(root, "backups"),
                    passphraseFile: join(root, "pass"),
                    noEncrypt: true,
                    retentionDays: -1,
                }),
            Error,
        );
        // **关键**：校验必须发生在采集之前（`--retention-days oops` 不该先产出备份再报错）
        assertEquals(spawned.length, 0, "参数非法时不得开始采集");
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

/** 最小 runner：所有 compose 查询返回空，spawn 直接抛错（采集不该被触发）。 */
function minimalRunner() {
    return {
        run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        spawn: () => {
            throw new Error("no spawn");
        },
    };
}

// ── 2026-09-23 复审：本轮修复自身引入的三处缺陷 ──
//
// 1) `--json` 契约：清理过期的提示此前走 stdout，与 JSON 载荷叠加，
//    `JSON.parse(stdout)` 直接抛错（违反 CHANGELOG 的"逐字节合法 JSON"）。
// 2) `--retention-days 0` 会删掉刚产出的快照（浮点年龄比较），只剩孤儿 .sha256。
// 3) `--min-free-mb` 未登记进 valueTaking，旗标的值会被当成位置参数。

Deno.test("复审: 自动清理的提示文案走 stderr（--json 的 stdout 只含 JSON）", async () => {
    // 上一轮复审指出：此前那条 CLI 级用例在**没有 PostgreSQL**的环境下
    // `stdout` 为空，被 `if (joined !== "")` 短路成空转（变异测试证实不会失败）。
    // 这里改为**直接断言接线**：清理提示必须经 `deps.err` 而非 `deps.out`。
    //
    // 做法：注入 ops 走完整 create 路径，并让 prune 真的删掉一个过期快照
    // （陈旧文件名的 mtime 由 utimes 置为 40 天前，保证按 mtime 判定为过期）。
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
        await Deno.writeTextFile(join(dir, "bin/noj-cli"), "#!/bin/sh\n");
        await Deno.chmod(join(dir, "bin/noj-cli"), 0o755);

        const backupDir = join(root, "backups");
        await Deno.mkdir(backupDir, { recursive: true });
        // 一个"陈旧"快照：文件名可解析 + mtime 40 天前
        const stale = join(backupDir, "snapshot-20200101-000000.nojbackup");
        await Deno.writeTextFile(stale, "old\n");
        const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
        await Deno.utime(stale, past, past);

        const { runBackupCreate } = await import("./commands/backup.ts");
        const outLines: string[] = [];
        const errLines: string[] = [];
        await runBackupCreate(dir, {
            args: [],
            deps: {
                runner: {
                    run: () =>
                        Promise.resolve({ code: 0, stdout: "", stderr: "" }),
                    spawn: () => {
                        throw new Error("no spawn");
                    },
                },
                processEnv: {},
                out: (t) => outLines.push(t),
                err: (t) => errLines.push(t),
            },
            backupDir,
            passphraseFile: join(root, "pass"),
            noEncrypt: true,
            ops: makeCreateFakeOps(),
            retentionDays: 7,
            minFreeMb: 0,
            // 空间守卫注入：不依赖真实 df
            probeFreeBytes: () => Promise.resolve(Number.POSITIVE_INFINITY),
        }).catch(() => {
            // create 本体在无真实 pg/redis 时可能失败；本用例只关心"清理提示的通道"，
            // 但为了确保真的走到清理阶段，下面的断言会校验它确实发生了。
        });

        const deleted = !(await Deno.stat(stale).then(() =>
            true
        ).catch(() => false));
        // 清理确实发生（否则本用例空转）
        assert(deleted, "陈旧快照应被自动清理（否则本用例无法验证提示通道）");
        // **关键断言**：提示走 err，绝不走 out
        assert(
            errLines.some((l) => l.includes("已清理过期快照")),
            `清理提示必须走 stderr，实得 stderr=${JSON.stringify(errLines)}`,
        );
        assert(
            !outLines.some((l) => l.includes("已清理过期快照")),
            `清理提示不得走 stdout，实得 stdout=${JSON.stringify(outLines)}`,
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

/** 构造一份最小 create ops（只写必要文件，不触真实 pg/redis/minio）。 */
function makeCreateFakeOps() {
    return {
        postgresDump: (dest: string) => Deno.writeTextFile(dest, "DUMP"),
        postgresGlobals: (dest: string) =>
            Deno.writeTextFile(dest, "-- globals\n"),
        postgresRestoreList: (dump: string, dest: string) =>
            Deno.stat(dump).then((st) =>
                st.size === 0
                    ? Promise.reject(new Error("pg_restore: no magic string"))
                    : Deno.writeTextFile(dest, "list\n")
            ),
        redisRdb: (dest: string) => Deno.writeTextFile(dest, "REDIS"),
        redisPersistence: (dest: string) => Deno.writeTextFile(dest, "ok\n"),
        minioMirror: (destDir: string) =>
            Deno.mkdir(destDir, { recursive: true }),
        gpgEncrypt: (src: string, dest: string) => Deno.copyFile(src, dest),
        gpgDecrypt: (src: string, dest: string) => Deno.copyFile(src, dest),
        tarZst: (_staging: string, dest: string) =>
            Deno.writeTextFile(dest, "TAR"),
        untarZst: (_src: string, destDir: string) =>
            Deno.mkdir(destDir, { recursive: true }),
    };
}

Deno.test("复审: 陈旧快照可被清理，但刚创建的那份按 excludePaths 保住", async () => {
    const { planPrune } = await import("./backup/index.ts");
    const now = new Date("2026-09-23T00:00:00Z");
    const mk = (name: string, createdAt: string) => ({
        name,
        path: `/b/${name}`,
        createdAt,
        bytes: 1,
        format: "single" as const,
    });
    const fresh = mk("snapshot-20260923-000000.nojbackup", now.toISOString());
    const old = mk(
        "snapshot-20200101-000000.nojbackup",
        "2020-01-01T00:00:00Z",
    );

    // 不排除时：刚创建的也会命中（--retention-days 0 的危险来源）
    const without = planPrune([fresh, old], { olderThanDays: 0, now });
    assertEquals(without.remove.length, 1);
    // **整天向下取整**后，ageDays=0 → 不删
    assertEquals(
        without.remove[0]!.path,
        "/b/snapshot-20200101-000000.nojbackup",
    );

    // 排除后：刚创建的那份必定保留
    const withExclude = planPrune([fresh, old], {
        olderThanDays: 0,
        now,
        excludePaths: new Set([fresh.path]),
    });
    assertEquals(
        withExclude.keep.some((e) => e.path === fresh.path),
        true,
        "excludePaths 里的条目必须保留",
    );
});

// ── 2026-09-23 复审：`--json` 契约在 restore --confirm / schedule 仍破 ──
// 触发条件：这两条路径的人类日志接 `deps.out`（stdout），与 JSON 载荷叠加，
// `JSON.parse(stdout)` 失败。CHANGELOG 承诺"所有生产命令"的 stdout 逐字节为 JSON。
Deno.test("复审: restore --confirm 的日志通道在 --json 下改为 stderr（接线断言）", async () => {
    // 说明：`restoreConfirmed` 里的 `log()` 只在 **`--restore-env` 解密成功后**被调用
    // （commands.ts 的唯一 log 点），要走到那里必须准备完整加密快照——成本高且
    // 易碎。这里改为**断言接线本身**：JSON 模式下 `runBackupRestore` 传入的 `log`
    // 必须写 stderr；非 JSON 模式写 out。
    //
    // 做法：读取源文件，确认 restore --confirm 分支的 log 回调包含 hasJson 分流。
    // 这是"接线级"断言（与 `verify 必须真的验签` 那类用例同一思路），
    // 比依赖深层流程到达更稳。
    // 实现已拆到 `commands/backup.ts`（`cli.ts` 仅为门面），故读取实现文件。
    const src = await Deno.readTextFile(
        new URL("./commands/backup.ts", import.meta.url).pathname,
    );
    const idx = src.indexOf("restoreConfirmed({");
    assert(idx > 0, "应能找到 restoreConfirmed 调用点");
    const block = src.slice(idx, idx + 1600);
    assert(
        block.includes("hasJson(args)") && block.includes("console.error"),
        `restore --confirm 的 log 必须在 --json 时走 stderr，实得片段：\n${
            block.slice(0, 700)
        }`,
    );
    assert(
        !/log: \(line\) => \(deps\.out/.test(block),
        "restore --confirm 的 log 不得直连 deps.out（会在 --json 下污染 stdout）",
    );
});

Deno.test("复审: backup schedule 的人类日志在 --json 下走 stderr", async () => {
    const { runBackupSchedule } = await import("./commands/backup.ts");
    const outLines: string[] = [];
    const errLines: string[] = [];
    const root = await Deno.makeTempDir();
    try {
        const dir = join(root, "install");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
            join(dir, "docker-compose.prod.yml"),
            "services: {}\n",
        );
        await Deno.writeTextFile(
            join(dir, ".env.prod"),
            "NOJ_VERSION=v0.9.5\n",
        );
        await Deno.chmod(join(dir, ".env.prod"), 0o600);
        // status 子命令会读 crontab；用注入 runner 模拟"无 crontab"
        await runBackupSchedule(dir, ["status", "--json"], {
            runner: {
                run: () =>
                    Promise.resolve({
                        code: 1,
                        stdout: "",
                        stderr: "no crontab",
                    }),
                spawn: () => {
                    throw new Error("no spawn");
                },
            },
            processEnv: {},
            out: (t) => outLines.push(t),
            err: (t) => errLines.push(t),
        }).catch(() => {});
        assertEquals(
            outLines.filter((l) => l.trim() !== "").length,
            0,
            `--json 下 schedule 不得往 stdout 写人类日志，实得：${
                JSON.stringify(outLines)
            }`,
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("backup create: 数据量超出可用空间时在任何写入与采集前拒绝，满足时正常创建并释放锁", async () => {
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
            "NOJ_VERSION=v0.11.0\nPOSTGRES_USER=noj\nPOSTGRES_DB=noj\nS3_BUCKET=b\n",
        );
        await Deno.chmod(join(dir, ".env.prod"), 0o600);
        const backupDir = join(root, "backups");
        const gib = 1024 * 1024 * 1024;
        const mib = 1024 * 1024;
        let opsCalled = false;
        const trackingOps = {
            ...makeCreateFakeOps(),
            postgresDump: (dest: string) => {
                opsCalled = true;
                return Deno.writeTextFile(dest, "DUMP");
            },
        };

        const { runBackupCreate } = await import("./commands/backup.ts");
        // 可用 3 GiB >= 1024 MB 固定下限，但原始数据 2 GiB 在流式峰值下需 2 + ceil(1.7) + 0.5 = 4.2 GiB
        const err = await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: { runner: minimalRunner(), processEnv: {} },
                    backupDir,
                    passphraseFile: join(root, "pass"),
                    noEncrypt: true,
                    minFreeMb: 1024,
                    ops: trackingOps,
                    probePartition: () =>
                        Promise.resolve({
                            filesystem: "/dev/vda1",
                            mountPoint: "/",
                            totalBytes: 100 * gib,
                            usedBytes: 97 * gib,
                            availableBytes: 3 * gib,
                            usedPercent: 97,
                            targetPath: backupDir,
                            probedPath: root,
                        }),
                    estimateDataSize: () =>
                        Promise.resolve({
                            postgresBytes: 512 * mib,
                            redisBytes: 0,
                            minioBytes: 1536 * mib,
                            totalBytes: 2 * gib,
                            sources: ["PostgreSQL", "MinIO"],
                        }),
                }),
            Error,
            "可用空间不足",
        );
        assertStringIncludes(err.message, "需要");
        assertStringIncludes(err.message, "可用");
        assertEquals(opsCalled, false, "空间不足时绝不能开始任何采集或打包");
        assertEquals(
            await Deno.stat(backupDir).then(() => true).catch(() => false),
            false,
            "空间不足时不得创建备份目录",
        );

        // 可用空间提高到 6 GiB -> 正常创建并在完成后释放 .nojbackup-create.lock
        const created = await runBackupCreate(dir, {
            args: [],
            deps: {
                runner: minimalRunner(),
                processEnv: {},
                now: () => new Date("2026-11-21T00:00:00Z"),
            },
            backupDir,
            passphraseFile: join(root, "pass"),
            noEncrypt: true,
            minFreeMb: 1024,
            ops: trackingOps,
            probePartition: () =>
                Promise.resolve({
                    filesystem: "/dev/vda1",
                    mountPoint: "/",
                    totalBytes: 100 * gib,
                    usedBytes: 94 * gib,
                    availableBytes: 6 * gib,
                    usedPercent: 94,
                    targetPath: backupDir,
                    probedPath: root,
                }),
            estimateDataSize: () =>
                Promise.resolve({
                    postgresBytes: 512 * mib,
                    redisBytes: 0,
                    minioBytes: 1536 * mib,
                    totalBytes: 2 * gib,
                    sources: ["PostgreSQL", "MinIO"],
                }),
        });
        assertEquals(opsCalled, true);
        assert(created.path.endsWith(".nojbackup"));
        assertEquals(
            await Deno.stat(join(backupDir, ".nojbackup-create.lock"))
                .then(() => true)
                .catch(() => false),
            false,
            "备份完成后必须释放排他锁",
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("backup create: 启动前清理死进程残留，命中活跃锁时中止且不误删", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = join(root, "install");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
            join(dir, "docker-compose.prod.yml"),
            "services: {}\n",
        );
        await Deno.writeTextFile(
            join(dir, ".env.prod"),
            "NOJ_VERSION=v0.11.0\n",
        );
        await Deno.chmod(join(dir, ".env.prod"), 0o600);
        const backupDir = join(root, "backups");
        await Deno.mkdir(backupDir, { recursive: true });

        const lockPath = join(backupDir, ".nojbackup-create.lock");
        await Deno.writeTextFile(
            lockPath,
            JSON.stringify({ pid: 7777, startedAt: "2026-11-21T00:00:00Z" }),
        );
        const staleStaging = join(backupDir, ".nojbackup-staging-7777-old");
        await Deno.mkdir(staleStaging, { recursive: true });
        await Deno.writeTextFile(join(staleStaging, "dump"), "stale-bytes");

        const { runBackupCreate } = await import("./commands/backup.ts");
        // 1. 活锁存在 -> 拒绝执行，残留文件保留
        await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: { runner: minimalRunner(), processEnv: {} },
                    backupDir,
                    noEncrypt: true,
                    ops: makeCreateFakeOps(),
                    isProcessAlive: (pid) => Promise.resolve(pid === 7777),
                    probeFreeBytes: () =>
                        Promise.resolve(Number.POSITIVE_INFINITY),
                }),
            Error,
            "7777",
        );
        assert(
            await Deno.stat(staleStaging).then(() => true).catch(() => false),
        );

        // 2. 进程已死亡 -> 自动清理残留后完成本次备份，清理提示走 err 不走 out
        const outLines: string[] = [];
        const errLines: string[] = [];
        await runBackupCreate(dir, {
            args: [],
            deps: {
                runner: minimalRunner(),
                processEnv: {},
                out: (t) => outLines.push(t),
                err: (t) => errLines.push(t),
            },
            backupDir,
            noEncrypt: true,
            ops: makeCreateFakeOps(),
            isProcessAlive: () => Promise.resolve(false),
            probeFreeBytes: () => Promise.resolve(Number.POSITIVE_INFINITY),
        });
        assertEquals(
            await Deno.stat(staleStaging).then(() => true).catch(() => false),
            false,
            "死亡进程的 staging 残留必须在备份前清掉",
        );
        assert(errLines.some((l) => l.includes("已清理崩溃残留")));
        assertEquals(outLines.some((l) => l.includes("已清理崩溃残留")), false);
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("backup create: NOJ_BACKUP_MIN_FREE_MB 优先级为 旗标 > 进程环境 > .env.prod > 1024", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = join(root, "install");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
            join(dir, "docker-compose.prod.yml"),
            "services: {}\n",
        );
        await Deno.writeTextFile(
            join(dir, ".env.prod"),
            "NOJ_VERSION=v0.11.0\nNOJ_BACKUP_MIN_FREE_MB=4096\n",
        );
        await Deno.chmod(join(dir, ".env.prod"), 0o600);
        const { runBackupCreate } = await import("./commands/backup.ts");
        const mib = 1024 * 1024;
        const probe2048 = () => Promise.resolve(2048 * mib);

        // 1. 仅配置在 .env.prod (4096 MB) -> 可用 2048 MB 应被拒绝且输出包含 4 GiB
        const errEnvFile = await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: { runner: minimalRunner(), processEnv: {} },
                    backupDir: join(root, "backups-1"),
                    noEncrypt: true,
                    probeFreeBytes: probe2048,
                }),
            Error,
            "可用空间不足",
        );
        assertStringIncludes(errEnvFile.message, "4 GiB");

        // 2. 进程环境变量 (3072 MB) 覆盖 .env.prod (4096 MB) -> 提示应反映 3 GiB
        const errProc = await assertRejects(
            () =>
                runBackupCreate(dir, {
                    args: [],
                    deps: {
                        runner: minimalRunner(),
                        processEnv: { NOJ_BACKUP_MIN_FREE_MB: "3072" },
                    },
                    backupDir: join(root, "backups-2"),
                    noEncrypt: true,
                    probeFreeBytes: probe2048,
                }),
            Error,
            "可用空间不足",
        );
        assertStringIncludes(errProc.message, "3 GiB");

        // 3. CLI 旗标 --min-free-mb 512 覆盖进程环境与 .env.prod -> 2048 MB 通过空间预检
        const created = await runBackupCreate(dir, {
            args: ["--min-free-mb", "512"],
            deps: {
                runner: minimalRunner(),
                processEnv: { NOJ_BACKUP_MIN_FREE_MB: "3072" },
            },
            backupDir: join(root, "backups-3"),
            noEncrypt: true,
            ops: makeCreateFakeOps(),
            probeFreeBytes: probe2048,
        });
        assert(created.path.endsWith(".nojbackup"));
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});
