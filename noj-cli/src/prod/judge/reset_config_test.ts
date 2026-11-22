/**
 * `judge reset-config` 与 `judgeStop` 单元测试：
 * - 前缀/组名推导、Redis URL 严格解析与凭据零回显；
 * - 真实 TCP RESP2 协议机：`AUTH` → `SELECT` → `EVAL` 严格顺序、失败即中止、挂起超时清理；
 * - `docker compose config` 权威环境变量解析与覆盖；
 * - `REDIS_CHECK_URL` 一致性校验、多行 `--pools` 拒绝/规范化；
 * - 停机/清锁前双文件预暂存、二阶段提交失败自动回滚与 `judgeStop` 优雅排空宽限期。
 */

import {
    assert,
    assertEquals,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "yaml";
import type {
    CmdResult,
    CommandRunner,
    SpawnHandle,
} from "../../runtime/command.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import { UsageError } from "../../util/args.ts";
import { judgeStop } from "./actions.ts";
import { renderJudgeCompose } from "./compose.ts";
import {
    findForbiddenHostCalls,
    JUDGE_DEFAULT_VALUES,
    JUDGE_ENV_MODE,
    readJudgeEnv,
} from "./config.ts";
import { encodeRespCommand, evalRedisScriptStrict } from "./redis-resp.ts";
import {
    deriveJudgeClaimPrefix,
    JUDGE_RESET_LUA,
    judgeResetConfig,
    resolveJudgeResourceGroup,
    resourceGroupKeys,
} from "./reset-config.ts";
import {
    computeJudgeStopTimeoutSeconds,
    parseRedisConnection,
    parseResolvedComposeEnv,
    patchJudgeComposeEnvironment,
    readJudgeComposeEnv,
    resolveHostRedisConnection,
} from "./reset-config-helpers.ts";

interface Call {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
}

function makeRunner(
    calls: Call[],
    opts: {
        failOn?: (cmd: string, args: string[]) => boolean;
        stdoutFor?: (cmd: string, args: string[]) => string | undefined;
        codeFor?: (cmd: string, args: string[]) => number | undefined;
        composeConfigStdout?: string;
        onRun?: (
            cmd: string,
            args: string[],
            runOpts?: { env?: Record<string, string>; timeoutMs?: number },
        ) => Promise<void> | void;
    } = {},
): CommandRunner {
    return {
        async run(cmd, args, runOpts) {
            calls.push({
                cmd,
                args: [...args],
                env: runOpts?.env,
                timeoutMs: runOpts?.timeoutMs,
            });
            await opts.onRun?.(cmd, args, runOpts);
            const code = opts.codeFor?.(cmd, args) ??
                (opts.failOn?.(cmd, args) === true ? 1 : 0);
            let stdout = opts.stdoutFor?.(cmd, args);
            if (
                stdout === undefined &&
                code === 0 &&
                args.includes("compose") &&
                args.includes("config")
            ) {
                if (opts.composeConfigStdout !== undefined) {
                    stdout = opts.composeConfigStdout;
                } else {
                    const envIdx = args.indexOf("--env-file");
                    const fileIdx = args.indexOf("-f");
                    const envPath = envIdx >= 0 ? args[envIdx + 1] : undefined;
                    const composePath = fileIdx >= 0
                        ? args[fileIdx + 1]
                        : undefined;
                    if (envPath && composePath) {
                        const envValues = await readJudgeEnv(envPath);
                        const composeText = await Deno.readTextFile(
                            composePath,
                        );
                        const resolved = readJudgeComposeEnv(
                            composeText,
                            envValues,
                            {},
                        );
                        stdout = resolved !== null
                            ? stringifyYaml({
                                services: { judge: { environment: resolved } },
                            })
                            : "";
                    }
                }
            }
            return {
                code,
                stdout: stdout ?? "",
                stderr: code === 0 ? "" : "injected failure",
            } as CmdResult;
        },
        spawn(): SpawnHandle {
            throw new Error("reset-config 测试不 spawn");
        },
    };
}

async function makeJudgeDir(
    root: string,
    overrides: Record<string, string> = {},
    opts: { commentHeader?: string; customCompose?: string } = {},
): Promise<string> {
    const dir = join(root, "judge");
    await Deno.mkdir(dir, { recursive: true });
    const env: Record<string, string> = {
        ...JUDGE_DEFAULT_VALUES,
        NOJ_VERSION: "v0.11.0-rc.2",
        REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
        REDIS_CHECK_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
        JUDGE_RESOURCE_GROUP: "judge-node-1",
        ...overrides,
    };
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const header = opts.commentHeader ?? "# 保留的头部注释\n";
    await Deno.writeTextFile(
        join(dir, ".env.judge"),
        header + lines.join("\n") + "\n",
    );
    await Deno.chmod(join(dir, ".env.judge"), JUDGE_ENV_MODE);
    await Deno.writeTextFile(
        join(dir, "docker-compose.judge.yml"),
        opts.customCompose ?? renderJudgeCompose(env),
    );
    await Deno.chmod(join(dir, "docker-compose.judge.yml"), 0o600);
    return dir;
}

interface FakeRespExchange {
    commands: string[][];
}

async function withFakeRespServer(
    handler: (args: string[]) => string | null,
    runTest: (port: number, exchange: FakeRespExchange) => Promise<void>,
): Promise<void> {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const addr = listener.addr as Deno.NetAddr;
    const activeSockets = new Set<Deno.Conn>();
    const exchange: FakeRespExchange = { commands: [] };
    const connTasks: Promise<void>[] = [];

    const acceptLoop = (async () => {
        for await (const socket of listener) {
            activeSockets.add(socket);
            const task = (async () => {
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                let buf = new Uint8Array(0);
                const readLine = (): string | null => {
                    for (let i = 0; i + 1 < buf.byteLength; i++) {
                        if (buf[i] === 13 && buf[i + 1] === 10) {
                            const line = decoder.decode(buf.subarray(0, i));
                            buf = buf.slice(i + 2);
                            return line;
                        }
                    }
                    return null;
                };
                const parseNextCommand = (): string[] | null => {
                    const saved = buf;
                    const header = readLine();
                    if (header === null || !header.startsWith("*")) {
                        buf = saved;
                        return null;
                    }
                    const count = Number.parseInt(header.slice(1), 10);
                    const args: string[] = [];
                    for (let i = 0; i < count; i++) {
                        const lenLine = readLine();
                        if (lenLine === null || !lenLine.startsWith("$")) {
                            buf = saved;
                            return null;
                        }
                        const len = Number.parseInt(lenLine.slice(1), 10);
                        if (buf.byteLength < len + 2) {
                            buf = saved;
                            return null;
                        }
                        args.push(decoder.decode(buf.subarray(0, len)));
                        buf = buf.slice(len + 2);
                    }
                    return args;
                };

                try {
                    const chunk = new Uint8Array(4096);
                    while (true) {
                        const n = await socket.read(chunk);
                        if (n === null) break;
                        const next = new Uint8Array(buf.byteLength + n);
                        next.set(buf, 0);
                        next.set(chunk.subarray(0, n), buf.byteLength);
                        buf = next;
                        while (true) {
                            const cmd = parseNextCommand();
                            if (cmd === null) break;
                            exchange.commands.push(cmd);
                            const reply = handler(cmd);
                            if (reply === null) continue; // 模拟静默挂起等待客户端断开
                            await socket.write(encoder.encode(reply));
                        }
                    }
                } catch {
                    // 忽略测试结束关连接引发的读/写中断
                } finally {
                    activeSockets.delete(socket);
                    try {
                        socket.close();
                    } catch {
                        // 忽略
                    }
                }
            })();
            connTasks.push(task);
        }
    })().catch(() => {});

    try {
        await runTest(addr.port, exchange);
    } finally {
        try {
            listener.close();
        } catch {
            // 忽略
        }
        for (const s of activeSockets) {
            try {
                s.close();
            } catch {
                // 忽略
            }
        }
        await acceptLoop;
        await Promise.allSettled(connTasks);
    }
}

Deno.test("deriveJudgeClaimPrefix 与 resolveJudgeResourceGroup 对齐 Rust 规则", () => {
    assertEquals(deriveJudgeClaimPrefix({}), "noj:judge");
    assertEquals(
        deriveJudgeClaimPrefix({ JUDGE_QUEUE: "custom:pool:tasks" }),
        "custom:pool",
    );
    assertEquals(deriveJudgeClaimPrefix({ JUDGE_QUEUE: "flat" }), "flat");
    assertEquals(
        deriveJudgeClaimPrefix({
            JUDGE_QUEUE: "a:b",
            JUDGE_USER_CLAIM_PREFIX: "explicit:prefix",
        }),
        "explicit:prefix",
    );
    assertEquals(
        deriveJudgeClaimPrefix(
            { JUDGE_USER_CLAIM_PREFIX: "explicit:prefix" },
            "cli:override",
        ),
        "cli:override",
    );

    assertThrows(() => deriveJudgeClaimPrefix({}, "  "), UsageError);
    assertThrows(() => deriveJudgeClaimPrefix({}, "bad prefix!"), UsageError);

    assertEquals(
        resolveJudgeResourceGroup({ JUDGE_RESOURCE_GROUP: "g1" }),
        "g1",
    );
    assertEquals(
        resolveJudgeResourceGroup({ JUDGE_RESOURCE_GROUP: "g1" }, "g2"),
        "g2",
    );
    assertThrows(() => resolveJudgeResourceGroup({}), UsageError);
    assertThrows(() => resolveJudgeResourceGroup({}, " "), UsageError);
    assertThrows(() => resolveJudgeResourceGroup({}, "bad/group"), UsageError);

    assertEquals(resourceGroupKeys("noj:judge", "g1"), [
        "noj:judge:resources:g1",
        "noj:judge:resources:g1:rss",
        "noj:judge:resources:g1:config",
        "noj:judge:resources:g1:requests",
        "noj:judge:resources:g1:turns",
        "noj:judge:resources:g1:turn-sequence",
        "noj:judge:resources:g1:sequence",
    ]);
    assertEquals(JUDGE_RESET_LUA.includes("\n"), false);
    assertEquals(JUDGE_RESET_LUA.includes('"'), false);
    assertEquals(JUDGE_RESET_LUA.includes("$"), false);

    // encodeRespCommand 必须按 UTF-8 字节长度编码，而非 UTF-16 字符数。
    const frame = new TextDecoder().decode(encodeRespCommand(["SET", "键"]));
    assertEquals(frame, "*2\r\n$3\r\nSET\r\n$3\r\n键\r\n");
});

Deno.test("Redis URL 严格解析、含 '/' 口令零回显、一致健康检查地址校验与历史 local 兼容", () => {
    const conn = parseRedisConnection(
        "rediss://alice:p%40ss%3Aword@redis.internal:16380/7",
        "REDIS_URL",
    );
    assertEquals(conn, {
        tls: true,
        host: "redis.internal",
        port: 16380,
        db: 7,
        username: "alice",
        password: "p@ss:word",
    });

    // 含未转义 '/' 或非法端口/协议/DB 路径时必须拒绝且绝不回显原始 URL 与口令
    for (
        const bad of [
            "redis://:pa/ss/word@127.0.0.1:6379/0",
            "redis://:pa#ss/secret@127.0.0.1:6379/0",
            "redis://:topsecret@127.0.0.1:0/0",
            "redis://:topsecret@127.0.0.1:99999/0",
            "redis://:topsecret@127.0.0.1:6379/not-a-db",
            "http://:topsecret@127.0.0.1:6379/0",
        ]
    ) {
        let msg = "";
        try {
            parseRedisConnection(bad, "REDIS_CHECK_URL");
        } catch (err) {
            msg = (err as Error).message;
        }
        assert(msg !== "", `必须拒绝非法 Redis URL: ${bad}`);
        assertStringIncludes(msg, "REDIS_CHECK_URL");
        assertEquals(msg.includes("topsecret"), false, "错误消息不得回显口令");
        assertEquals(msg.includes("pa/ss/word"), false, "含 '/' 口令不得回显");
        assertEquals(msg.includes("pa#ss"), false, "含 '#' 口令不得回显");
    }

    // 同实例同库可确认映射：host.docker.internal ↔ 127.0.0.1 应接受宿主机回环地址
    const mapped = resolveHostRedisConnection({
        REDIS_URL: "redis://:pw@host.docker.internal:16379/2",
        REDIS_CHECK_URL: "redis://:pw@127.0.0.1:16379/2",
    });
    assertEquals(mapped.host, "127.0.0.1");
    assertEquals(mapped.port, 16379);
    assertEquals(mapped.db, 2);

    // 历史 --redis-mode local 反置兼容：REDIS_CHECK_URL=host.docker.internal + REDIS_URL=127.0.0.1 → 选 127.0.0.1
    const compat = resolveHostRedisConnection({
        REDIS_URL: "redis://:pw@127.0.0.1:16379/0",
        REDIS_CHECK_URL: "redis://:pw@host.docker.internal:16379/0",
    });
    assertEquals(compat.host, "127.0.0.1");
    assertEquals(compat.port, 16379);

    // 过期或不一致的 REDIS_CHECK_URL（主机/端口/DB/TLS/凭据任一不同）必须拒绝
    for (
        const staleCheck of [
            "redis://:pw@127.0.0.1:16379/0", // host 不同（main 为 redis.internal）
            "redis://:pw@host.docker.internal:26379/0", // port 不同
            "redis://:pw@host.docker.internal:16379/1", // db 不同
            "rediss://:pw@redis.internal:16379/0", // tls 不同
            "redis://:wrong@redis.internal:16379/0", // 口令不同
        ]
    ) {
        assertThrows(
            () =>
                resolveHostRedisConnection({
                    REDIS_URL: "redis://:pw@redis.internal:16379/0",
                    REDIS_CHECK_URL: staleCheck,
                }),
            UsageError,
        );
    }
});

Deno.test("严格 RESP2 协议：AUTH + SELECT + EVAL 顺序执行（单密码与 ACL 用户+密码）", async () => {
    await withFakeRespServer((args) => {
        if (args[0] === "AUTH" || args[0] === "SELECT") return "+OK\r\n";
        if (args[0] === "EVAL") return ":1\r\n";
        return "-ERR unexpected\r\n";
    }, async (port, exchange) => {
        const res = await evalRedisScriptStrict(
            { tls: false, host: "127.0.0.1", port, db: 7, password: "pw" },
            JUDGE_RESET_LUA,
            ["k1", "k2"],
            5000,
        );
        assertEquals(res, { ok: true, cleared: true });
        assertEquals(exchange.commands, [
            ["AUTH", "pw"],
            ["SELECT", "7"],
            ["EVAL", JUDGE_RESET_LUA, "2", "k1", "k2"],
        ]);
    });

    await withFakeRespServer((args) => {
        if (args[0] === "AUTH" || args[0] === "SELECT") return "+OK\r\n";
        if (args[0] === "EVAL") return ":0\r\n";
        return "-ERR unexpected\r\n";
    }, async (port, exchange) => {
        const res = await evalRedisScriptStrict(
            {
                tls: false,
                host: "127.0.0.1",
                port,
                db: 2,
                username: "alice",
                password: "pw",
            },
            JUDGE_RESET_LUA,
            ["k1"],
            5000,
        );
        assertEquals(res, { ok: true, cleared: false });
        assertEquals(exchange.commands, [
            ["AUTH", "alice", "pw"],
            ["SELECT", "2"],
            ["EVAL", JUDGE_RESET_LUA, "1", "k1"],
        ]);
    });
});

Deno.test("严格 RESP2 协议：SELECT 超界或 AUTH 失败时立即中止，绝不发送 EVAL 且不回显口令", async () => {
    // 1) SELECT 超界错误：不得发出 EVAL
    await withFakeRespServer((args) => {
        if (args[0] === "AUTH") return "+OK\r\n";
        if (args[0] === "SELECT") return "-ERR DB index is out of range\r\n";
        return ":1\r\n";
    }, async (port, exchange) => {
        const res = await evalRedisScriptStrict(
            { tls: false, host: "127.0.0.1", port, db: 99, password: "s3cret" },
            JUDGE_RESET_LUA,
            ["k1"],
            5000,
        );
        assertEquals(res.ok, false);
        if (!res.ok) {
            assertEquals(res.timedOut, false);
            assertStringIncludes(res.message, "DB 99");
            assertEquals(res.message.includes("s3cret"), false);
        }
        assertEquals(exchange.commands, [
            ["AUTH", "s3cret"],
            ["SELECT", "99"],
        ]);
    });

    // 2) AUTH 失败：不得发出 SELECT 或 EVAL，且绝不泄露口令
    await withFakeRespServer((args) => {
        if (args[0] === "AUTH") {
            return "-WRONGPASS invalid username-password pair\r\n";
        }
        return "+OK\r\n";
    }, async (port, exchange) => {
        const res = await evalRedisScriptStrict(
            {
                tls: false,
                host: "127.0.0.1",
                port,
                db: 0,
                password: "top-secret-password",
            },
            JUDGE_RESET_LUA,
            ["k1"],
            5000,
        );
        assertEquals(res.ok, false);
        if (!res.ok) {
            assertEquals(res.timedOut, false);
            assertStringIncludes(res.message, "认证失败");
            assertEquals(res.message.includes("top-secret-password"), false);
        }
        assertEquals(exchange.commands, [["AUTH", "top-secret-password"]]);
    });

    // 3) 服务端挂起不回包：严格在 timeoutMs 内超时退出并清理套接字
    await withFakeRespServer(() => null, async (port) => {
        const res = await evalRedisScriptStrict(
            { tls: false, host: "127.0.0.1", port, db: 0 },
            JUDGE_RESET_LUA,
            ["k1"],
            50,
        );
        assertEquals(res.ok, false);
        if (!res.ok) {
            assertEquals(res.timedOut, true);
            assertStringIncludes(res.message, "超时");
        }
    });
});

Deno.test("安全与前置校验：非法并发/超时/坏 URL/多行 pools/不一致 CHECK_URL 在停机与清锁前退出 2", async () => {
    const root = await makeTempDir();
    try {
        const dir = await makeJudgeDir(root);
        const calls: Call[] = [];
        const runner = makeRunner(calls);
        let evalCalled = false;
        const guardEval = () => {
            evalCalled = true;
            return Promise.resolve({ ok: true as const, cleared: true });
        };

        const badTasks = await judgeResetConfig({
            dir,
            runner,
            restart: true,
            updates: { JUDGE_AI_TASK_CONCURRENCY: "0" },
            evalRedis: guardEval,
        });
        assertEquals(badTasks.exitCode, 2);
        assertEquals(calls.length, 0);

        const badTimeout = await judgeResetConfig({
            dir,
            runner,
            restart: true,
            waitTimeoutSeconds: 3601,
            evalRedis: guardEval,
        });
        assertEquals(badTimeout.exitCode, 2);
        assertEquals(calls.length, 0);

        const badKey = await judgeResetConfig({
            dir,
            runner,
            updates: { REDIS_URL: "redis://other" },
            evalRedis: guardEval,
        });
        assertEquals(badKey.exitCode, 2);
        assertEquals(calls.length, 0);

        // 逗号后含换行的 --pools 必须被拒绝
        const badMultilinePools = await judgeResetConfig({
            dir,
            runner,
            updates: { JUDGE_RESOURCE_POOLS: "oi-wasm,\nai" },
            evalRedis: guardEval,
        });
        assertEquals(badMultilinePools.exitCode, 2);
        assertEquals(calls.length, 0);

        // 含 '/' 的坏口令与坏 REDIS_CHECK_URL 在停机/Redis 前拒绝且不回显凭据
        const badSlashPwDir = await makeJudgeDir(join(root, "slash-pw"), {
            REDIS_URL: "redis://:pa/ss/word@127.0.0.1:6379/0",
            REDIS_CHECK_URL: "redis://:pa/ss/word@127.0.0.1:6379/0",
        });
        const badSlashPw = await judgeResetConfig({
            dir: badSlashPwDir,
            runner,
            restart: true,
            evalRedis: guardEval,
        });
        assertEquals(badSlashPw.exitCode, 2);
        assertEquals(badSlashPw.message.includes("pa/ss/word"), false);
        assertEquals(calls.some((c) => c.args.includes("stop")), false);

        // 过期或不一致的 REDIS_CHECK_URL（DB 0 vs DB 2）必须拒绝，不得触发停机或清锁
        const staleCheckUrlDir = await makeJudgeDir(join(root, "stale-check"), {
            REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/2",
            REDIS_CHECK_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
        });
        const staleCheck = await judgeResetConfig({
            dir: staleCheckUrlDir,
            runner,
            restart: true,
            evalRedis: guardEval,
        });
        assertEquals(staleCheck.exitCode, 2);
        assertEquals(calls.some((c) => c.args.includes("stop")), false);

        // 共享 Docker socket 守卫必须在最前拦截
        const badDir = join(root, "shared-judge");
        await Deno.mkdir(badDir, { recursive: true });
        const badEnv = {
            ...JUDGE_DEFAULT_VALUES,
            NOJ_VERSION: "v0.11.0-rc.2",
            REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
            JUDGE_RESOURCE_GROUP: "judge-node-1",
            JUDGE_DOCKER_SOCKET: "/var/run/docker.sock",
        };
        await Deno.writeTextFile(
            join(badDir, ".env.judge"),
            Object.entries(badEnv).map(([k, v]) => `${k}=${v}`).join("\n") +
                "\n",
        );
        await Deno.chmod(join(badDir, ".env.judge"), JUDGE_ENV_MODE);
        await Deno.writeTextFile(
            join(badDir, "docker-compose.judge.yml"),
            "services: {}\n",
        );
        const sharedSock = await judgeResetConfig({
            dir: badDir,
            runner,
            evalRedis: guardEval,
        });
        assertEquals(sharedSock.exitCode, 2);
        assertStringIncludes(
            sharedSock.message,
            "禁止使用应用宿主机 Docker socket",
        );
        assertEquals(evalCalled, false);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("权威 Compose 解析：shell 覆盖 ${GROUP} 生效；compose config 失败时停机与清锁均不执行", async () => {
    const root = await makeTempDir();
    try {
        const customCompose = [
            "services:",
            "  judge:",
            "    image: ghcr.io/neuro-oj/noj-judge:v0.11.0-rc.2",
            "    environment:",
            '      REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/0"',
            '      JUDGE_RESOURCE_GROUP: "${GROUP:-env-group}"',
            '      JUDGE_QUEUE: "noj:judge:queue"',
            "",
        ].join("\n");
        const dir = await makeJudgeDir(root, { GROUP: "env-group" }, {
            customCompose,
        });

        // 1) 真实模式：docker compose config 返回 shell 覆盖的 shell-group
        const seenKeys: string[][] = [];
        const calls1: Call[] = [];
        const resShell = await judgeResetConfig({
            dir,
            runner: makeRunner(calls1, {
                composeConfigStdout: stringifyYaml({
                    services: {
                        judge: {
                            environment: {
                                REDIS_URL:
                                    "redis://:s3cret-pw@127.0.0.1:6379/0",
                                JUDGE_RESOURCE_GROUP: "shell-group",
                                JUDGE_QUEUE: "noj:judge:queue",
                            },
                        },
                    },
                }),
            }),
            stop: true,
            evalRedis: (_conn, _lua, keys) => {
                seenKeys.push([...keys]);
                return Promise.resolve({ ok: true, cleared: true });
            },
        });
        assertEquals(resShell.exitCode, 0, resShell.message);
        assertEquals(resShell.resourceGroup, "shell-group");
        assert(seenKeys[0]!.includes("noj:judge:resources:shell-group:config"));

        // 2) dry-run 模式：hostEnv 优先级高于 .env.judge，零 runner 调用
        const callsDry: Call[] = [];
        const resDry = await judgeResetConfig({
            dir,
            runner: makeRunner(callsDry),
            dryRun: true,
            hostEnv: { GROUP: "shell-dry-group" },
        });
        assertEquals(resDry.exitCode, 0, resDry.message);
        assertEquals(resDry.resourceGroup, "shell-dry-group");
        assertEquals(callsDry.length, 0);

        // 3) compose config 失败 或 缺少 environment 时必须在停机和 Redis 前中止
        const callsFail: Call[] = [];
        let redisTouched = false;
        const resFail = await judgeResetConfig({
            dir,
            runner: makeRunner(callsFail, {
                codeFor: (_c, args) => args.includes("config") ? 1 : 0,
            }),
            stop: true,
            evalRedis: () => {
                redisTouched = true;
                return Promise.resolve({ ok: true, cleared: true });
            },
        });
        assertEquals(resFail.exitCode, 1);
        assertEquals(resFail.cleared, false);
        assertEquals(redisTouched, false);
        assertEquals(callsFail.some((c) => c.args.includes("stop")), false);

        const callsMissingEnv: Call[] = [];
        const resMissingEnv = await judgeResetConfig({
            dir,
            runner: makeRunner(callsMissingEnv, {
                composeConfigStdout: "services:\n  judge: {}\n",
            }),
            stop: true,
            evalRedis: () => {
                redisTouched = true;
                return Promise.resolve({ ok: true, cleared: true });
            },
        });
        assertEquals(resMissingEnv.exitCode, 1);
        assertEquals(redisTouched, false);
        assertEquals(
            callsMissingEnv.some((c) => c.args.includes("stop")),
            false,
        );

        // parseResolvedComposeEnv 将 null 值归一化为空串
        const parsedNull = parseResolvedComposeEnv(
            "services:\n  judge:\n    environment:\n      FOO: null\n      BAR: ok\n",
        );
        assertEquals(parsedNull, { FOO: "", BAR: "ok" });
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Compose 定制保留与 --pools 规范化：仅 --restart 不重写；更新只改目标键并保留 external 网络与注释", async () => {
    const root = await makeTempDir();
    try {
        const customCompose = `${
            renderJudgeCompose({
                ...JUDGE_DEFAULT_VALUES,
                NOJ_VERSION: "v0.11.0-rc.2",
                REDIS_URL: "redis://:s3cret-pw@127.0.0.1:6379/0",
                JUDGE_RESOURCE_GROUP: "judge-node-1",
            }).replace(
                `networks:\n  noj-eval-net:\n    name: "noj-eval-net"\n    driver: bridge\n    internal: true`,
                `# 自定义外部隔离网络\nnetworks:\n  noj-eval-net:\n    name: custom-shared-eval\n    external: true`,
            )
        }`;
        const dir = await makeJudgeDir(root, {}, { customCompose });
        const calls: Call[] = [];

        // 1) 仅 --restart，未改参数：Compose 必须逐字节保留
        const restartOnly = await judgeResetConfig({
            dir,
            runner: makeRunner(calls),
            restart: true,
            evalRedis: () => Promise.resolve({ ok: true, cleared: true }),
        });
        assertEquals(restartOnly.exitCode, 0, restartOnly.message);
        assertEquals(
            await Deno.readTextFile(join(dir, "docker-compose.judge.yml")),
            customCompose,
            "仅 --restart 时不得改写自定义 Compose",
        );

        // 2) 修改并发与带空白的资源池 + 重建：必须保留定制并规范化 pools 为单行无空格
        const updated = await judgeResetConfig({
            dir,
            runner: makeRunner(calls),
            restart: true,
            updates: {
                JUDGE_AI_TASK_CONCURRENCY: "8",
                JUDGE_RESOURCE_POOLS: "oi-wasm, ai",
            },
            evalRedis: () => Promise.resolve({ ok: true, cleared: true }),
        });
        assertEquals(updated.exitCode, 0, updated.message);
        const parsedEnv = await readJudgeEnv(join(dir, ".env.judge"));
        assertEquals(parsedEnv["JUDGE_RESOURCE_POOLS"], "oi-wasm,ai");
        const afterCompose = await Deno.readTextFile(
            join(dir, "docker-compose.judge.yml"),
        );
        assertStringIncludes(afterCompose, "# 自定义外部隔离网络");
        assertStringIncludes(afterCompose, "name: custom-shared-eval");
        assertStringIncludes(afterCompose, "external: true");
        assertStringIncludes(afterCompose, 'JUDGE_AI_TASK_CONCURRENCY: "8"');
        assertStringIncludes(
            afterCompose,
            'JUDGE_RESOURCE_POOLS: "oi-wasm,ai"',
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Compose YAML 局部更新：支持 sequence 形式与 hostEnv > envFile 优先级", () => {
    const seqCompose = [
        "services:",
        "  judge:",
        "    image: ghcr.io/neuro-oj/noj-judge:v0.11.0-rc.2",
        "    environment:",
        "      - JUDGE_QUEUE=custom:q:tasks",
        "      - JUDGE_RESOURCE_GROUP=${MY_GROUP:-g1}",
        "      - JUDGE_AI_TASK_CONCURRENCY=2",
        "",
    ].join("\n");
    const parsed = readJudgeComposeEnv(
        seqCompose,
        { MY_GROUP: "env-group" },
        { MY_GROUP: "host-group" },
    );
    assertEquals(parsed?.["JUDGE_QUEUE"], "custom:q:tasks");
    assertEquals(parsed?.["JUDGE_RESOURCE_GROUP"], "host-group");
    const patched = patchJudgeComposeEnvironment(seqCompose, {
        JUDGE_AI_TASK_CONCURRENCY: "6",
        JUDGE_RESOURCE_MEMORY_MB: "4096",
    });
    assertStringIncludes(patched, "- JUDGE_AI_TASK_CONCURRENCY=6");
    assertStringIncludes(patched, "- JUDGE_RESOURCE_MEMORY_MB=4096");
    assertStringIncludes(patched, "- JUDGE_QUEUE=custom:q:tasks");
});

Deno.test("Worker 实际生效前缀与 judgeStop 优雅停机宽限期对齐", async () => {
    assertEquals(computeJudgeStopTimeoutSeconds({}), 120);
    assertEquals(
        computeJudgeStopTimeoutSeconds({
            SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "150",
        }),
        210,
    );

    const root = await makeTempDir();
    try {
        const dir = await makeJudgeDir(root, {
            JUDGE_USER_CLAIM_PREFIX: "unused:env:prefix",
            JUDGE_QUEUE: "real:queue:tasks",
            SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "150",
        });
        const calls: Call[] = [];
        const logs: string[] = [];
        let sentKeys: readonly string[] = [];

        const result = await judgeResetConfig({
            dir,
            runner: makeRunner(calls),
            stop: true,
            log: (l) => logs.push(l),
            evalRedis: (_conn, _lua, keys) => {
                sentKeys = keys;
                return Promise.resolve({ ok: true, cleared: true });
            },
        });

        assertEquals(result.exitCode, 0, result.message);
        assertEquals(result.claimPrefix, "real:queue");
        assert(
            logs.some((l) =>
                l.includes("未注入该变量") && l.includes("real:queue")
            ),
        );
        const stopCall = calls.find((c) => c.args.includes("stop"));
        assertEquals(stopCall?.args.slice(-3), ["stop", "-t", "210"]);
        assert(sentKeys.includes("real:queue:resources:judge-node-1:config"));

        // 独立 judgeStop 也必须保留 Worker 排空宽限期
        const defaultDir = await makeJudgeDir(join(root, "stop-default"));
        const stopDefaultCalls: Call[] = [];
        const stopDefaultRes = await judgeStop({
            dir: defaultDir,
            runner: makeRunner(stopDefaultCalls),
        });
        assertEquals(stopDefaultRes.exitCode, 0);
        assertEquals(
            stopDefaultCalls[0]!.args.slice(-3),
            ["stop", "-t", "120"],
            "默认 judgeStop 必须传 stop -t 120",
        );

        const stopLongCalls: Call[] = [];
        const stopLongRes = await judgeStop({
            dir,
            runner: makeRunner(stopLongCalls),
        });
        assertEquals(stopLongRes.exitCode, 0);
        assertEquals(
            stopLongCalls[0]!.args.slice(-3),
            ["stop", "-t", "210"],
            "高下载超时配置的 judgeStop 必须传 stop -t 210",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("pre-stop 双文件预暂存与二阶段提交失败自动回滚", async () => {
    const root = await makeTempDir();
    try {
        // 1) 目录不可写：应在停机与清锁前于 pre-stop 阶段失败并中止（非 root 生效）
        if (Deno.uid() !== 0) {
            const roDir = await makeJudgeDir(join(root, "readonly"));
            const calls: Call[] = [];
            let redisTouched = false;
            await Deno.chmod(roDir, 0o555);
            try {
                const res = await judgeResetConfig({
                    dir: roDir,
                    runner: makeRunner(calls),
                    stop: true,
                    updates: { JUDGE_AI_TASK_CONCURRENCY: "6" },
                    evalRedis: () => {
                        redisTouched = true;
                        return Promise.resolve({ ok: true, cleared: true });
                    },
                });
                assertEquals(res.exitCode, 1);
                assertEquals(res.cleared, false);
                assertEquals(redisTouched, false);
                assertEquals(calls.some((c) => c.args.includes("stop")), false);
            } finally {
                await Deno.chmod(roDir, 0o755);
            }
        }

        // 2) 第二阶段提交 Compose 失败：必须自动将 .env.judge 回滚至原始内容与权限且不留临时文件
        const dirRollback = await makeJudgeDir(join(root, "rollback"));
        const envPath = join(dirRollback, ".env.judge");
        const composePath = join(dirRollback, "docker-compose.judge.yml");
        await Deno.chmod(envPath, 0o400);
        const envBefore = await Deno.readTextFile(envPath);
        const composeBefore = await Deno.readTextFile(composePath);

        const rollbackRes = await judgeResetConfig({
            dir: dirRollback,
            runner: makeRunner([]),
            updates: { JUDGE_AI_TASK_CONCURRENCY: "8" },
            evalRedis: () => Promise.resolve({ ok: true, cleared: true }),
            commitFile: async (stagedPath, destPath) => {
                if (destPath === composePath) {
                    throw new Error("模拟磁盘只读或空间不足");
                }
                await Deno.rename(stagedPath, destPath);
            },
        });
        assertEquals(rollbackRes.exitCode, 1);
        assertEquals(rollbackRes.cleared, true);
        assertEquals(rollbackRes.updatedKeys, []);
        assertStringIncludes(rollbackRes.message, "自动回滚");
        assertEquals(await Deno.readTextFile(envPath), envBefore);
        assertEquals(await Deno.readTextFile(composePath), composeBefore);
        const restoredMode = ((await Deno.stat(envPath)).mode ?? 0) & 0o777;
        assertEquals(restoredMode.toString(8), "400");
        const leftoverTmp: string[] = [];
        for await (const entry of Deno.readDir(dirRollback)) {
            if (entry.name.includes(".tmp-")) leftoverTmp.push(entry.name);
        }
        assertEquals(leftoverTmp, [], "不得遗留暂存临时文件");

        // 3) 第一阶段提交 .env.judge 失败：两原文件均保持未修改且清理临时文件
        const dirFirstFail = await makeJudgeDir(join(root, "first-fail"));
        const envBefore1 = await Deno.readTextFile(
            join(dirFirstFail, ".env.judge"),
        );
        const composeBefore1 = await Deno.readTextFile(
            join(dirFirstFail, "docker-compose.judge.yml"),
        );
        const firstFailRes = await judgeResetConfig({
            dir: dirFirstFail,
            runner: makeRunner([]),
            updates: { JUDGE_AI_TASK_CONCURRENCY: "8" },
            evalRedis: () => Promise.resolve({ ok: true, cleared: true }),
            commitFile: () => Promise.reject(new Error("模拟 rename 失败")),
        });
        assertEquals(firstFailRes.exitCode, 1);
        assertEquals(firstFailRes.cleared, true);
        assertEquals(firstFailRes.updatedKeys, []);
        assertEquals(
            await Deno.readTextFile(join(dirFirstFail, ".env.judge")),
            envBefore1,
        );
        assertEquals(
            await Deno.readTextFile(
                join(dirFirstFail, "docker-compose.judge.yml"),
            ),
            composeBefore1,
        );
        const leftoverTmp1: string[] = [];
        for await (const entry of Deno.readDir(dirFirstFail)) {
            if (entry.name.includes(".tmp-")) leftoverTmp1.push(entry.name);
        }
        assertEquals(leftoverTmp1, []);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("dry-run、轮询等待、超时未排空与完整端到端 RESP 重建", async () => {
    const root = await makeTempDir();
    try {
        // 1) dry-run：零 runner 调用，零文件修改
        const dryDir = await makeJudgeDir(join(root, "dry"));
        const envBefore = await Deno.readTextFile(join(dryDir, ".env.judge"));
        const composeBefore = await Deno.readTextFile(
            join(dryDir, "docker-compose.judge.yml"),
        );
        const dryCalls: Call[] = [];
        const logs: string[] = [];
        const dryRes = await judgeResetConfig({
            dir: dryDir,
            runner: makeRunner(dryCalls),
            dryRun: true,
            restart: true,
            updates: { JUDGE_AI_TASK_CONCURRENCY: "6" },
            log: (line) => logs.push(line),
        });
        assertEquals(dryRes.exitCode, 0);
        assertEquals(dryCalls.length, 0);
        assertEquals(
            await Deno.readTextFile(join(dryDir, ".env.judge")),
            envBefore,
        );
        assertEquals(
            await Deno.readTextFile(join(dryDir, "docker-compose.judge.yml")),
            composeBefore,
        );
        assertStringIncludes(logs.join("\n"), "stop -t 120");

        // 2) 轮询重试与超时未排空（不改写配置且不重建容器）
        const pollDir = await makeJudgeDir(join(root, "poll"));
        let attempt = 0;
        let fakeNowMs = 1_000_000;
        const sleeps: number[] = [];
        const pollRes = await judgeResetConfig({
            dir: pollDir,
            runner: makeRunner([]),
            waitTimeoutSeconds: 10,
            pollIntervalMs: 2500,
            now: () => new Date(fakeNowMs),
            sleep: (ms) => {
                sleeps.push(ms);
                fakeNowMs += ms;
                return Promise.resolve();
            },
            evalRedis: () => {
                attempt++;
                return Promise.resolve({ ok: true, cleared: attempt > 1 });
            },
        });
        assertEquals(pollRes.exitCode, 0);
        assertEquals(pollRes.cleared, true);
        assertEquals(attempt, 2);
        assertEquals(sleeps, [2500]);

        const timeoutDir = await makeJudgeDir(join(root, "timeout"));
        const tEnvBefore = await Deno.readTextFile(
            join(timeoutDir, ".env.judge"),
        );
        const tCalls: Call[] = [];
        let fakeNowTimeout = 1_000_000;
        const timeoutRes = await judgeResetConfig({
            dir: timeoutDir,
            runner: makeRunner(tCalls),
            waitTimeoutSeconds: 5,
            pollIntervalMs: 3000,
            now: () => new Date(fakeNowTimeout),
            sleep: (ms) => {
                fakeNowTimeout += ms;
                return Promise.resolve();
            },
            restart: true,
            updates: { JUDGE_AI_TASK_CONCURRENCY: "6" },
            evalRedis: () => Promise.resolve({ ok: true, cleared: false }),
        });
        assertEquals(timeoutRes.exitCode, 1);
        assertEquals(timeoutRes.cleared, false);
        assertEquals(
            await Deno.readTextFile(join(timeoutDir, ".env.judge")),
            tEnvBefore,
        );
        assertEquals(tCalls.some((c) => c.args.includes("up")), false);

        // 3) 端到端通过真实 TCP RESP2 服务器：compose config → stop -t 120 → AUTH/SELECT/EVAL → 局部更新 → force-recreate
        await withFakeRespServer((args) => {
            if (args[0] === "AUTH" || args[0] === "SELECT") return "+OK\r\n";
            if (args[0] === "EVAL") return ":1\r\n";
            return "-ERR bad\r\n";
        }, async (port, exchange) => {
            const e2eDir = await makeJudgeDir(join(root, "e2e"), {
                REDIS_URL: `redis://:s3cret-pw@host.docker.internal:${port}/3`,
                REDIS_CHECK_URL: `redis://:s3cret-pw@127.0.0.1:${port}/3`,
            });
            const e2eCalls: Call[] = [];
            const e2eRes = await judgeResetConfig({
                dir: e2eDir,
                runner: makeRunner(e2eCalls),
                restart: true,
                updates: { JUDGE_AI_TASK_CONCURRENCY: "6" },
            });
            assertEquals(e2eRes.exitCode, 0, e2eRes.message);
            assertEquals(e2eRes.cleared, true);
            assertEquals(e2eRes.restarted, true);
            assertEquals(findForbiddenHostCalls(e2eCalls), []);
            assertEquals(exchange.commands.map((c) => c[0]), [
                "AUTH",
                "SELECT",
                "EVAL",
            ]);
            assertEquals(exchange.commands[1], ["SELECT", "3"]);
            assertStringIncludes(
                await Deno.readTextFile(join(e2eDir, ".env.judge")),
                "# 保留的头部注释",
            );
            assertStringIncludes(
                await Deno.readTextFile(
                    join(e2eDir, "docker-compose.judge.yml"),
                ),
                'JUDGE_AI_TASK_CONCURRENCY: "6"',
            );
            const upFailDir = await makeJudgeDir(join(root, "up-fail"), {
                REDIS_URL: `redis://:s3cret-pw@127.0.0.1:${port}/3`,
                REDIS_CHECK_URL: `redis://:s3cret-pw@127.0.0.1:${port}/3`,
            });
            const upFailRes = await judgeResetConfig({
                dir: upFailDir,
                runner: makeRunner([], { failOn: (_c, a) => a.includes("up") }),
                restart: true,
                updates: { JUDGE_AI_TASK_CONCURRENCY: "6" },
            });
            assertEquals(upFailRes.exitCode, 1);
            assertEquals(upFailRes.cleared, true);
            assertEquals(upFailRes.restarted, false);
            assertStringIncludes(upFailRes.message, "noj-cli judge start");
        });
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
