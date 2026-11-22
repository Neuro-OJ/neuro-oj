/**
 * Tier 3 · 服务端管理命令的容器执行原语。
 *
 * 把 `noj-cli db migrate` 这类短命令包装为
 * `docker compose --env-file <dir>/.env.prod -f <dir>/docker-compose.prod.yml run --rm --entrypoint /app/bin/noj core …`，
 * 以参数数组（而非 shell 字符串）构造，从结构上消除注入与转义问题。
 * 哪些命令走 Tier 3 由 `commands.ts` 的命令表声明。
 */
import { join } from "@std/path";

/** 容器内 CLI 的路径（`noj-core/Dockerfile`：`--output /app/bin/noj`）。 */
export const CONTAINER_CLI = "/app/bin/noj";

/** Tier 3 命令的 Compose service（`core` 是 service 名，非子命令）。 */
export const CONTAINER_SERVICE = "core";

/** 构造 compose 参数。 */
export interface ComposeArgsOptions {
    composeFile: string;
    envFile: string;
    service: string;
    /** 容器内 CLI 的子命令与参数。 */
    command: string[];
    /** 以 `--no-deps` 运行（不创建/启动依赖服务；maintain 需要）。 */
    noDeps?: boolean;
}

/** 构造 `docker compose … run --rm --entrypoint /app/bin/noj <service> <args>`。 */
export function buildComposeArgs(options: ComposeArgsOptions): string[] {
    return [
        "compose",
        "--env-file",
        options.envFile,
        "-f",
        options.composeFile,
        "run",
        "--rm",
        ...(options.noDeps === true ? ["--no-deps"] : []),
        "--entrypoint",
        CONTAINER_CLI,
        options.service,
        ...options.command,
    ];
}

/** 单个参数是否需要引号（shell 安全渲染用）。 */
function quoteIfNeeded(arg: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
    // 双引号内必须同时转义反斜杠、双引号、美元符与反引号，避免 shell 二次解释。
    const escaped = arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
        .replaceAll("$", "\\$").replaceAll("`", "\\`");
    return `"${escaped}"`;
}

/** 渲染为可复制执行的一行命令（`--dry-run` 输出）。 */
export function renderDryRun(args: string[]): string {
    return ["docker", ...args].map(quoteIfNeeded).join(" ");
}

/** 定位生产安装目录下的 compose 与 env 文件路径。 */
export function productionPaths(dir: string): {
    composeFile: string;
    envFile: string;
} {
    return {
        composeFile: join(dir, "docker-compose.prod.yml"),
        envFile: join(dir, ".env.prod"),
    };
}

/** 执行选项。 */
export interface RunContainerOptions {
    /** 生产安装目录。 */
    dir: string;
    service: string;
    /** 容器内 CLI 的子命令与参数。 */
    command: string[];
    /** 以 `--no-deps` 运行（不创建/启动依赖服务）。 */
    noDeps?: boolean;
    /** 仅打印将执行的命令，不实际执行。 */
    dryRun?: boolean;
    /** 输出渲染后的命令（默认 console.log）。 */
    log?: (line: string) => void;
}

/**
 * 以容器方式执行 Tier 3 命令，**原样透传退出码**。
 *
 * `stdin: "inherit"` 是硬要求：`bootstrap first-admin` 需隐藏输入密码，
 * 必须让子进程直接接管终端。
 */
export async function runInContainer(
    options: RunContainerOptions,
): Promise<number> {
    const { composeFile, envFile } = productionPaths(options.dir);
    const args = buildComposeArgs({
        composeFile,
        envFile,
        service: options.service,
        command: options.command,
        noDeps: options.noDeps,
    });

    if (options.dryRun) {
        (options.log ?? console.log)(`dry-run: ${renderDryRun(args)}`);
        return 0;
    }

    const child = new Deno.Command("docker", {
        args,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).spawn();
    return (await child.status).code;
}
