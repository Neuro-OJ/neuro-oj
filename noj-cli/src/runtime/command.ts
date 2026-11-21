/** 命令执行结果。 */
export interface CmdResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** spawn 进程的参数。 */
export interface SpawnOpts {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** 存在时把子进程 stdout 追加写入该文件。 */
    stdoutFile?: string;
    /** 存在时把子进程 stderr 追加写入该文件。 */
    stderrFile?: string;
}

/** 已启动进程的句柄：记录 PID，可等待退出或终止。 */
export interface SpawnHandle {
    pid: number;
    /** 等待进程退出，返回退出码。 */
    wait(): Promise<number>;
    /** 发送 SIGTERM 终止进程（失败静默）。 */
    kill(): Promise<void>;
}

/** `pipe` 单侧子进程规格。 */
export interface PipeSpec {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

/** `pipe` 双子进程管道执行结果。 */
export interface PipeResult {
    firstCode: number;
    secondCode: number;
    firstStderr: string;
    secondStderr: string;
}

/**
 * 系统命令/进程抽象：deploy 的所有 docker 调用与进程管理只经该接口，
 * 便于测试注入 fake 模拟 docker / process。
 */
export interface CommandRunner {
    run(
        cmd: string,
        args: string[],
        opts?: {
            cwd?: string;
            env?: Record<string, string>;
            stdin?: string;
            timeoutMs?: number;
        },
    ): Promise<CmdResult>;
    spawn(opts: SpawnOpts): SpawnHandle;
    /**
     * 无 shell 直连管道：`first.stdout` 字节流直接 `pipeTo` `second.stdin`。
     *
     * 可选：既有仅测试 non-pipe 行为的 fake 可不实现。
     */
    pipe?(first: PipeSpec, second: PipeSpec): Promise<PipeResult>;
    /**
     * 逐行流式执行命令；`onLine` 每收到一行（不含换行）回调一次，返回退出码。
     *
     * `opts.onStderr` 控制 **stderr 的行路由**：
     * - 未提供（缺省）：stderr 与 stdout 一样逐行交给 `onLine`。这是安全默认——
     *   子进程写满 stderr 管道会**挂死**（Linux 管道缓冲约 64 KiB），排空是必需的，
     *   而"排空的字节必须有去处"。
     * - 提供回调：stderr 行交给它（可据此区分通道，例如人类日志 vs JSON）；
     * - 传 `false`：只排空、不转发（调用方自会处理诊断输出）。
     *
     * 可选：P2 既有 fake 可不实现。
     */
    stream?(
        cmd: string,
        args: string[],
        onLine: (line: string) => void,
        opts?: {
            cwd?: string;
            env?: Record<string, string>;
            onStderr?: ((line: string) => void) | false;
        },
    ): Promise<number>;
}

/** 真实实现：`Deno.Command` 的 run 与 spawn。 */
export function realRunner(): CommandRunner {
    const decoder = new TextDecoder();
    return {
        async run(cmd, args, opts) {
            const stdin = opts?.stdin;
            const timeoutMs = opts?.timeoutMs;
            if (
                stdin === undefined &&
                (timeoutMs === undefined || timeoutMs <= 0)
            ) {
                const p = new Deno.Command(cmd, {
                    args,
                    cwd: opts?.cwd,
                    env: opts?.env ?? {},
                    stdout: "piped",
                    stderr: "piped",
                });
                const out = await p.output();
                return {
                    code: out.code,
                    stdout: decoder.decode(out.stdout),
                    stderr: decoder.decode(out.stderr),
                };
            }
            const p = new Deno.Command(cmd, {
                args,
                cwd: opts?.cwd,
                env: opts?.env ?? {},
                stdin: stdin !== undefined ? "piped" : "null",
                stdout: "piped",
                stderr: "piped",
            });
            const child = p.spawn();
            // 先开始读 stdout/stderr，避免大 stdin 时子进程写满管道导致双方阻塞。
            const stdoutPromise = new Response(child.stdout).arrayBuffer()
                .catch(() => new ArrayBuffer(0));
            const stderrPromise = new Response(child.stderr).arrayBuffer()
                .catch(() => new ArrayBuffer(0));
            let stdinPromise: Promise<void> = Promise.resolve();
            if (stdin !== undefined) {
                stdinPromise = (async () => {
                    const writer = child.stdin.getWriter();
                    try {
                        await writer.write(new TextEncoder().encode(stdin));
                        await writer.close();
                    } catch {
                        // 子进程提前退出时忽略管道写入错误
                    }
                })();
            }
            let timedOut = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            if (timeoutMs !== undefined && timeoutMs > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    try {
                        child.kill("SIGTERM");
                    } catch {
                        // 已退出则忽略
                    }
                    killTimer = setTimeout(() => {
                        try {
                            child.kill("SIGKILL");
                        } catch {
                            // 已退出则忽略
                        }
                    }, 200);
                }, timeoutMs);
            }
            try {
                const [status, stdoutBuf, stderrBuf] = await Promise.all([
                    child.status,
                    stdoutPromise,
                    stderrPromise,
                ]);
                await stdinPromise.catch(() => {});
                if (timedOut) {
                    return {
                        code: 124,
                        stdout: "",
                        stderr: "command timed out",
                    };
                }
                return {
                    code: status.code,
                    stdout: decoder.decode(stdoutBuf),
                    stderr: decoder.decode(stderrBuf),
                };
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                if (killTimer !== undefined) clearTimeout(killTimer);
            }
        },
        spawn(opts) {
            const cmd = new Deno.Command(opts.cmd, {
                args: opts.args,
                cwd: opts.cwd,
                env: opts.env,
                stdout: opts.stdoutFile ? "piped" : "inherit",
                stderr: opts.stderrFile ? "piped" : "inherit",
            });
            const child = cmd.spawn();
            const pipes: Promise<void>[] = [];
            if (opts.stdoutFile) {
                const f = Deno.open(opts.stdoutFile, {
                    write: true,
                    create: true,
                    append: true,
                });
                pipes.push(
                    f.then((file) => child.stdout.pipeTo(file.writable)),
                );
            }
            if (opts.stderrFile) {
                const f = Deno.open(opts.stderrFile, {
                    write: true,
                    create: true,
                    append: true,
                });
                pipes.push(
                    f.then((file) => child.stderr.pipeTo(file.writable)),
                );
            }
            return {
                pid: child.pid,
                async wait() {
                    const code = (await child.status).code;
                    await Promise.allSettled(pipes);
                    return code;
                },
                kill() {
                    try {
                        child.kill("SIGTERM");
                    } catch {
                        // 已退出则忽略
                    }
                    return Promise.resolve();
                },
            };
        },
        async stream(cmd, args, onLine, opts) {
            const p = new Deno.Command(cmd, {
                args,
                cwd: opts?.cwd,
                env: opts?.env,
                stdout: "piped",
                stderr: "piped",
            });
            const child = p.spawn();
            // stderr 必须被持续排空：子进程一旦向 stderr 写入超过内核管道缓冲
            // （Linux 约 64 KiB）就会阻塞在 write 上，stdout 也随之不再产生新数据，
            // 下面的 reader.read() 与 child.status 将永远不返回（CLI 静默挂死）。
            // `--follow` 的子进程正是 `docker compose ... logs --follow`，多服务时
            // 会向 stderr 输出告警/进度，属真实可达路径。
            //
            // 行的去处由 `opts.onStderr` 决定：缺省与 stdout 同等对待
            // （安全默认，保证排空的字节可见）；传函数则分流；传 `false` 只排空。
            const stderrRoute = opts?.onStderr === undefined
                ? onLine
                : opts.onStderr === false
                ? null
                : opts.onStderr;
            const stderrDone = (async () => {
                const reader = child.stderr.getReader();
                let sbuf = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    sbuf += decoder.decode(value, { stream: true });
                    let idx: number;
                    while ((idx = sbuf.indexOf("\n")) !== -1) {
                        const line = sbuf.slice(0, idx);
                        sbuf = sbuf.slice(idx + 1);
                        if (stderrRoute !== null) {
                            stderrRoute(
                                line.endsWith("\r") ? line.slice(0, -1) : line,
                            );
                        }
                    }
                }
                if (sbuf.length > 0 && stderrRoute !== null) stderrRoute(sbuf);
            })();
            let buf = "";
            const reader = child.stdout.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 1);
                    if (line.endsWith("\r")) onLine(line.slice(0, -1));
                    else onLine(line);
                }
            }
            if (buf.length > 0) onLine(buf);
            const code = (await child.status).code;
            await stderrDone;
            return code;
        },
        async pipe(first, second) {
            const firstChild = new Deno.Command(first.cmd, {
                args: first.args,
                cwd: first.cwd,
                env: first.env ?? {},
                stdin: "null",
                stdout: "piped",
                stderr: "piped",
            }).spawn();
            const secondChild = new Deno.Command(second.cmd, {
                args: second.args,
                cwd: second.cwd,
                env: second.env ?? {},
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            }).spawn();

            let pipeDone = false;
            const pipePromise = firstChild.stdout
                .pipeTo(secondChild.stdin)
                .catch(() => {
                    // 下游提前退出导致写入端 EPIPE 时及时终止上游，避免写入阻塞
                    try {
                        firstChild.kill("SIGTERM");
                    } catch {
                        // 已退出则忽略
                    }
                })
                .finally(() => {
                    pipeDone = true;
                });

            // 并发排空两个子进程的 stderr 以及下游 stdout，防止 64KiB 管道缓冲写满死锁
            const firstStderrPromise = new Response(firstChild.stderr)
                .arrayBuffer()
                .catch(() => new ArrayBuffer(0));
            const secondStdoutPromise = new Response(secondChild.stdout)
                .arrayBuffer()
                .catch(() => new ArrayBuffer(0));
            const secondStderrPromise = new Response(secondChild.stderr)
                .arrayBuffer()
                .catch(() => new ArrayBuffer(0));

            const secondStatusPromise = secondChild.status;
            const watchEarlyExit = (async () => {
                await secondStatusPromise;
                if (pipeDone) return;
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    pipePromise,
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 20);
                    }),
                ]);
                if (timer !== undefined) clearTimeout(timer);
                if (!pipeDone) {
                    try {
                        firstChild.kill("SIGTERM");
                    } catch {
                        // 已退出则忽略
                    }
                }
            })();

            const [
                firstStatus,
                secondStatus,
                firstStderrBuf,
                _secondStdoutBuf,
                secondStderrBuf,
            ] = await Promise.all([
                firstChild.status,
                secondStatusPromise,
                firstStderrPromise,
                secondStdoutPromise,
                secondStderrPromise,
                pipePromise,
                watchEarlyExit,
            ]);

            return {
                firstCode: firstStatus.code,
                secondCode: secondStatus.code,
                firstStderr: decoder.decode(firstStderrBuf),
                secondStderr: decoder.decode(secondStderrBuf),
            };
        },
    };
}
