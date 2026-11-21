/**
 * 生产生命周期测试：install 的配置校验顺序、cosign 探测与既有目录保护。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { install, missingConfigError } from "./lifecycle.ts";
import { PRODUCTION_MARKERS } from "./install-dir.ts";
import {
    completeEnv,
    COMPOSE,
    COMPOSE_BODY,
    configOk,
    ENV_EXAMPLE,
    ENV_FILE,
    EXAMPLE_BODY,
    makeCliBinary,
    makeFetcher,
    makeInstalledDir,
    makeIO,
    makeRunner,
    REF,
    REPO,
    RunnerCall,
    throwingRunner,
    writePassphraseFile,
} from "./lifecycle_fixtures.ts";

Deno.test("install：调用顺序 judgeEnabledError → validateEnv（枚举非法优先报错）", async () => {
    // JUDGE_ENABLED=maybe 是枚举外值：judgeEnabledError 必须**先**拒绝，
    // 而不是被 validateEnv 静默当成"启用"后报一堆缺失键。
    const dir = await makeInstalledDir({ JUDGE_ENABLED: "maybe" });
    try {
        const passphrase = join(dir, "backup-passphrase");
        await writePassphraseFile(passphrase);
        const records: RunnerCall[] = [];
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], []),
                    runner: makeRunner(records),
                    fetcher: makeFetcher([], []),
                    nonInteractive: true,
                    passphraseFile: passphrase,
                    processEnv: {},
                    warn: () => {},
                }),
            Error,
            "JUDGE_ENABLED 必须是 true 或 false",
        );
        // 校验失败必须早于 compose：不得有任何 docker 调用。
        assertEquals(records, []);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install：judge 未设置 = 启用（要求 socket 且带 --profile judge）", async () => {
    const dir = await Deno.makeTempDir();
    try {
        // 去掉 JUDGE_ENABLED 行（=未设置=启用），并按"启用"补上 judge 条件键；
        // 否则缺失的是 JUDGE_* 而非 JUDGE_ENABLED，测不到"未设置=启用"。
        const lines = completeEnv({
            JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
            JUDGE_DOCKER_SOCKET_GID: "10001",
        })
            .split("\n")
            .filter((l) => !l.startsWith("JUDGE_ENABLED="));
        await Deno.writeTextFile(join(dir, ENV_FILE), lines.join("\n"));
        await Deno.chmod(join(dir, ENV_FILE), 0o600);
        await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
        const passphrase = join(dir, "backup-passphrase");
        await writePassphraseFile(passphrase);
        const records: RunnerCall[] = [];
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner(records),
            fetcher: makeFetcher([], []),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: {},
            warn: () => {},
            // 未设置 judge → 要求 socket 存在；给出注入点即视为存在。
            socketExists: () => Promise.resolve(true),
        });
        assertEquals(result.created, false);
        assertEquals(
            records
                .filter((r) => r.cmd === "docker")
                .every((r) =>
                    r.args.includes("--profile") && r.args.includes("judge")
                ),
            true,
            "judge 未设置 = 启用 → 所有 compose 调用必须带 --profile judge",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install：--passphrase-file 不抑制回填，仅进程环境抑制", async () => {
    // 场景 A：仅有 --passphrase-file（进程环境无该变量）→ 必须回填进 .env.prod。
    const a = await makeInstalledDir();
    const rootA = await Deno.makeTempDir();
    try {
        const passphrase = join(rootA, "pp");
        await install({
            dir: a,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner([]),
            fetcher: makeFetcher([], []),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: {},
            warn: () => {},
        });
        assertStringIncludes(
            await Deno.readTextFile(join(a, ENV_FILE)),
            "NOJ_BACKUP_PASSPHRASE_FILE=" + passphrase,
            "旗标路径必须回填（只有进程环境抑制回填）",
        );
    } finally {
        await Deno.remove(a, { recursive: true });
        await Deno.remove(rootA, { recursive: true });
    }

    // 场景 B：进程环境给出 NOJ_BACKUP_PASSPHRASE_FILE → 抑制回填。
    const b = await makeInstalledDir();
    const rootB = await Deno.makeTempDir();
    try {
        const flagPath = join(rootB, "flag-pp");
        const envPath = join(rootB, "env-pp");
        await writePassphraseFile(envPath);
        await install({
            dir: b,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner([]),
            fetcher: makeFetcher([], []),
            nonInteractive: true,
            passphraseFile: flagPath,
            processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: envPath },
            warn: () => {},
        });
        const text = await Deno.readTextFile(join(b, ENV_FILE));
        assertEquals(
            text.includes("NOJ_BACKUP_PASSPHRASE_FILE="),
            false,
            "进程环境已给出该变量 → 不得回填",
        );
    } finally {
        await Deno.remove(b, { recursive: true });
        await Deno.remove(rootB, { recursive: true });
    }
});

Deno.test("install：cosignAvailable 缺省注入真实探测（runner 执行 cosign version）", async () => {
    const dir = await makeInstalledDir({
        NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
    });
    try {
        const passphrase = join(dir, "backup-passphrase");
        await writePassphraseFile(passphrase);
        const records: RunnerCall[] = [];
        const warnings: string[] = [];
        // 不传 cosignAvailable → 走 probeCosign；runner 让 `cosign version` 失败，
        // 于是必须报错并告警（绝不因配置侧缺省 true 而静默"验签成功"）。
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], []),
                    runner: makeRunner(
                        records,
                        configOk((cmd) =>
                            cmd === "cosign"
                                ? { code: 127, stdout: "", stderr: "not found" }
                                : undefined
                        ),
                    ),
                    fetcher: makeFetcher([], []),
                    nonInteractive: true,
                    passphraseFile: passphrase,
                    processEnv: {},
                    warn: (m) => warnings.push(m),
                }),
            Error,
            "找不到 Cosign",
        );
        assertEquals(
            records.some((r) => r.cmd === "cosign" && r.args[0] === "version"),
            true,
            "缺省必须经 runner 真实探测 cosign（不得硬编码 true）",
        );
        assert(warnings.some((w) => w.includes("找不到 Cosign")));
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install：cosign 探测**抛 NotFound** → 仍按「找不到 Cosign」拒绝并告警", async () => {
    const dir = await makeInstalledDir({
        NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
    });
    try {
        const passphrase = join(dir, "backup-passphrase");
        await writePassphraseFile(passphrase);
        const records: RunnerCall[] = [];
        const warnings: string[] = [];
        // 真实 runner 在 cosign 不在 PATH 时抛 Deno.errors.NotFound（Deno.Command 语义），
        // 它必须与"未命中"落到同一个 false，否则 skip-with-warning 契约被裸异常顶替。
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], []),
                    runner: throwingRunner(records, (cmd) => cmd === "cosign"),
                    fetcher: makeFetcher([], []),
                    nonInteractive: true,
                    passphraseFile: passphrase,
                    processEnv: {},
                    warn: (m) => warnings.push(m),
                }),
            Error,
            "找不到 Cosign",
        );
        assertEquals(
            records.some((r) => r.cmd === "cosign" && r.args[0] === "version"),
            true,
            "缺省必须经 runner 真实探测 cosign（抛错也必须被探测到）",
        );
        assert(warnings.some((w) => w.includes("找不到 Cosign")));
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install 非交互 + 已安装但配置不完整：安装前报错，fetch 零、docker 零", async () => {
    // 已安装目录但仍是模板占位值（DOMAIN / POSTGRES_PASSWORD 命中占位黑名单）。
    const dir = await makeInstalledDir({
        DOMAIN: "change-me.example.com",
        POSTGRES_PASSWORD: "change-me-strong-postgres-password",
    });
    try {
        const records: RunnerCall[] = [];
        const calls: string[] = [];
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], []),
                    runner: makeRunner(records),
                    fetcher: makeFetcher(calls, []),
                    nonInteractive: true,
                    processEnv: {},
                    warn: () => {},
                }),
            Error,
            "生产配置校验失败",
        );
        assertEquals(calls, [], "非交互下配置不完整时不得下载资产");
        assertEquals(records, [], "非交互下配置不完整时不得调用 docker");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install 非交互（isTty=true）仍不进入向导：零 readLine，仅校验后报错", async () => {
    const dir = await makeInstalledDir({ DOMAIN: "change-me.example.com" });
    try {
        const events: string[] = [];
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], events),
                    runner: makeRunner([]),
                    fetcher: makeFetcher([], []),
                    nonInteractive: true,
                    isTty: true,
                    processEnv: {},
                    warn: () => {},
                }),
            Error,
            "生产配置校验失败",
        );
        assertEquals(
            events.filter((e) =>
                e.startsWith("read:") || e.startsWith("secret:")
            ),
            [],
            "--non-interactive 即便在 TTY 也必须零交互",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("registerCommand：源码运行模式（无 bin/noj-cli）→ 告警且不注册", async () => {
    const root = await Deno.makeTempDir();
    const dir = await makeInstalledDir();
    try {
        const passphrase = join(root, "pp");
        await writePassphraseFile(passphrase);
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner([]),
            fetcher: makeFetcher([], []),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: {},
            binDir: join(root, "bin"),
            userHome: join(root, "home"),
            warn: () => {},
        });
        assertEquals(result.registration.path, null);
        assert(
            result.registration.warnings.some((w) =>
                w.includes("源码运行模式")
            ),
            "无安装版二进制时必须告警（对照 register_command :98-101）",
        );
        assertEquals(
            await Deno.stat(join(root, "bin")).catch(() => null),
            null,
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("install 的保留判定只看 .env.prod 自身（两件套规则已退役）", async () => {
    // 旧实现：只有 .env.prod、没有 compose → 判成"未安装 → 首装缺配置"报错。
    // .env.prod 存在即保留，流程继续走到 compose。
    const dir = await Deno.makeTempDir();
    const root = await Deno.makeTempDir();
    try {
        await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv());
        await Deno.chmod(join(dir, ENV_FILE), 0o600);
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        const passphrase = join(root, "pp");
        await writePassphraseFile(passphrase);
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
            cosignAvailable: () => Promise.resolve(true),
            warn: () => {},
        });
        assertEquals(result.created, false, "有 .env.prod 即非首装");
        assertEquals(
            calls.length,
            4,
            "未按首装缺配置报错，而是拉资产补齐 compose",
        );
        assertEquals(
            records.some((r) => r.cmd === "docker" && r.args.includes("up")),
            true,
            "必须走到 compose up",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("PRODUCTION_MARKERS：唯一事实源就是 compose + .env.prod", () => {
    assertEquals([...PRODUCTION_MARKERS], [
        "docker-compose.prod.yml",
        ".env.prod",
    ]);
});

Deno.test("install 仅有 .env.prod（无 compose）：逐字节保留用户配置，绝不按模板重建", async () => {
    // 回归：曾用两件套判定"已安装"，于是"只有 .env.prod"被判成空目录首装 →
    // seedEnvFile 以 truncate:true 覆盖用户真实配置（数据销毁）。
    const dir = await Deno.makeTempDir();
    const root = await Deno.makeTempDir();
    try {
        const sentinel = "SENTINEL-" + "f".repeat(32);
        const original = completeEnv({
            DOMAIN: "old.test-oj.cn",
            POSTGRES_PASSWORD: sentinel,
        });
        await Deno.writeTextFile(join(dir, ENV_FILE), original);
        await Deno.chmod(join(dir, ENV_FILE), 0o600);
        await makeCliBinary(dir);
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        const events: string[] = [];
        const passphrase = join(root, "pp");
        await writePassphraseFile(passphrase);

        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], events),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, events),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
            cosignAvailable: () => Promise.resolve(true),
            socketExists: () => Promise.resolve(true),
            binDir: join(root, "bin"),
            userHome: join(root, "home"),
            warn: () => {},
        });

        // created 表示"是否由模板生成"，此处必须为 false。
        assertEquals(result.created, false);
        // 绝无 seed-env 步骤。
        assertEquals(
            result.steps.some((s) => s.name === "seed-env"),
            false,
            "既有 .env.prod 不得触发 seed-env",
        );
        // 既无 compose 资产 → 首装式 overwrite:false。
        assertEquals(result.steps[0]?.overwrite, false);
        // 关键断言一：哨兵值逐字节仍在。
        const after = await Deno.readTextFile(join(dir, ENV_FILE));
        assertEquals(after, original, "既有 .env.prod 必须逐字节保留");
        assertStringIncludes(after, sentinel);
        // 关键断言二：不是模板 seed（自动生成的随机密钥不会出现在原文件里）。
        assert(
            !after.includes("change-me-strong-postgres-password"),
            "不得被模板覆盖",
        );
        assertEquals(
            calls.length,
            4,
            "缺 compose 时仍须下载 compose + example 及其 .sha256",
        );
        // compose 与模板都已落盘（bootstrap 补自举）。
        assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
        assertEquals(
            await Deno.readTextFile(join(dir, ENV_EXAMPLE)),
            EXAMPLE_BODY,
        );
        assertEquals(
            ((await Deno.stat(join(dir, ENV_FILE))).mode ?? 0) & 0o777,
            0o600,
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("install 仅有 .env.prod（无 compose）：已验证配置时 compose 步骤仍可跑通", async () => {
    // 交叉场景：env 已存在 + compose 不存在。校验必须仍然通过（judge=false 时
    // compose 的 judge profile 不参与解析，故不会引用缺失键），且 compose 被下载。
    const dir = await Deno.makeTempDir();
    const root = await Deno.makeTempDir();
    try {
        await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv());
        await Deno.chmod(join(dir, ENV_FILE), 0o600);
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        const passphrase = join(root, "pp");
        await writePassphraseFile(passphrase);

        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            nonInteractive: true,
            passphraseFile: passphrase,
            processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
            cosignAvailable: () => Promise.resolve(true),
            warn: () => {},
        });

        assertEquals(result.created, false);
        assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
        const names = result.steps.map((s) => s.name);
        assert(names.includes("validate"), "校验步骤必须出现");
        assert(names.includes("compose-up"), "compose 启动步骤必须出现");
        assert(!names.includes("seed-env"), "不得 seed");
        // judge=false → 不带 --profile judge。
        assertEquals(
            records
                .filter((r) => r.cmd === "docker")
                .every((r) => !r.args.includes("--profile")),
            true,
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("install .env.prod 路径存在但不是普通文件 → 显式报错、零副作用（Finding 1）", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await Deno.mkdir(join(dir, ENV_FILE));
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        await assertRejects(
            () =>
                install({
                    dir,
                    repository: REPO,
                    ref: REF,
                    io: makeIO([], []),
                    runner: makeRunner(records),
                    fetcher: makeFetcher(calls, []),
                    nonInteractive: true,
                    processEnv: {},
                    warn: () => {},
                }),
            Error,
            "生产配置路径不是普通文件",
        );
        assertEquals(calls, [], "非普通文件时不得下载资产");
        assertEquals(records, [], "非普通文件时不得调用 docker");
        assertEquals(
            (await Deno.stat(join(dir, ENV_FILE))).isDirectory,
            true,
            "目录必须原样保留",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("install 空目录：仍由模板 seed .env.prod（正常路径回归守卫）", async () => {
    const dir = await Deno.makeTempDir();
    const root = await Deno.makeTempDir();
    try {
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        const passphrase = join(root, "pp");
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO(
                ["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"],
                [],
            ),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            isTty: true,
            passphraseFile: passphrase,
            processEnv: {},
            cosignAvailable: () => Promise.resolve(true),
            socketExists: () => Promise.resolve(true),
            binDir: join(root, "bin"),
            userHome: join(root, "home"),
            warn: () => {},
        });
        assertEquals(result.created, true);
        assert(
            result.steps.some((s) => s.name === "seed-env"),
            "空目录必须 seed",
        );
        const text = await Deno.readTextFile(join(dir, ENV_FILE));
        // 模板正文 + 真实随机密钥。
        assertStringIncludes(text, "STORAGE_PROVIDER=s3");
        assert(
            !text.includes("change-me-strong-postgres-password"),
            "占位口令必须被替换",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("install 非交互首装报错清单按 judge 状态条件化（Minor 2）", () => {
    // 未设置 JUDGE_ENABLED = 启用 → 报错清单含 JUDGE_KEYS。
    const enabled = missingConfigError({}).message;
    assertStringIncludes(enabled, "JUDGE_DOCKER_SOCKET");
    assertStringIncludes(enabled, "JUDGE_DOCKER_SOCKET_GID");
    // 显式关闭 → 不得再列 JUDGE_KEYS（否则误导用户填非必需键）。
    const disabled = missingConfigError({ JUDGE_ENABLED: "false" }).message;
    assert(
        !disabled.includes("JUDGE_DOCKER_SOCKET"),
        "judge 关闭时不得列出 JUDGE_KEYS",
    );
    // 核心键仍在。
    assertStringIncludes(disabled, "DOMAIN");
    assertStringIncludes(disabled, "JWT_SECRET");
});

Deno.test("install 升级路径：既有配置完整时不再进入向导（Minor 3 的步骤诚实性）", async () => {
    const dir = await makeInstalledDir();
    const root = await Deno.makeTempDir();
    try {
        const passphrase = join(root, "pp");
        await writePassphraseFile(passphrase);
        const events: string[] = [];
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], events),
            runner: makeRunner([]),
            fetcher: makeFetcher([], events),
            // TTY 但不非交互：配置已完整 → 向导不应被触发。
            isTty: true,
            passphraseFile: passphrase,
            processEnv: { NOJ_BACKUP_PASSPHRASE_FILE: passphrase },
            cosignAvailable: () => Promise.resolve(true),
            warn: () => {},
        });
        assertEquals(
            events.filter((e) =>
                e.startsWith("read:") || e.startsWith("secret:")
            ),
            [],
            "配置完整时不得有任何交互",
        );
        assertEquals(
            result.steps.some((s) => s.name === "configure"),
            false,
            "没做任何事时不得记录 configure 步骤",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("install 半成品目录（仅有 compose、缺 .env.prod）：允许覆盖重下，不误判为空目录", async () => {
    // 上次安装中途失败留下的 compose：若传 overwrite:false，bootstrap 会拒绝覆盖并让
    // 用户永远无法重试。overwrite 由 bootstrap 的资产清单决定。
    const dir = await Deno.makeTempDir();
    const root = await Deno.makeTempDir();
    try {
        await Deno.writeTextFile(join(dir, COMPOSE), "stale\n");
        await makeCliBinary(dir);
        const calls: string[] = [];
        const records: RunnerCall[] = [];
        const passphrase = join(root, "pp");
        const result = await install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO(
                ["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"],
                [],
            ),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            isTty: true,
            passphraseFile: passphrase,
            processEnv: {},
            cosignAvailable: () => Promise.resolve(true),
            socketExists: () => Promise.resolve(true),
            binDir: join(root, "bin"),
            userHome: join(root, "home"),
            warn: () => {},
        });
        // 覆盖模式生效：compose 被替换为新版本。
        assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
        assertEquals(result.steps[0]?.overwrite, true);
        // 无既有 .env.prod → 仍按首次安装生成配置。
        assertEquals(result.created, true);
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
});
