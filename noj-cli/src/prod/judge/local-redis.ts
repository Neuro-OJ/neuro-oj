/** 独立 Judge 的本机 Redis：仅绑定回环的容器创建、口令生成与端口/容器名校验。 */

import { join } from "@std/path";
import { UsageError } from "../../util/args.ts";
import { type CommandRunner } from "../../runtime/command.ts";

/** 默认 Redis 镜像。 */
export const DEFAULT_JUDGE_REDIS_IMAGE = "redis:7-alpine";

/** 本机 Redis 默认宿主机端口（`--redis-port` 缺省 16379）。 */
export const DEFAULT_REDIS_PORT = 16379;

/** 本机 Redis 默认容器名。 */
export const DEFAULT_REDIS_CONTAINER = "noj-judge-redis";

/** 本机 Redis 容器的归属标签——只管理带此标签的同名容器。 */
export const REDIS_COMPONENT_LABEL = "judge-standalone-redis";
/** 管理方标签值。 */
export const REDIS_MANAGED_BY_LABEL = "judge-install";

/** 校验本机 Redis 端口。 */
export function assertRedisPort(port: number): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new UsageError(
            `本机 Redis 端口必须在 1024-65535 范围内：${port}`,
        );
    }
}

/** 校验本机 Redis 容器名。 */
export function assertRedisContainerName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
        throw new UsageError(`本机 Redis 容器名格式无效：${name}`);
    }
}

/**
 * 生成本机 Redis 口令。
 *
 * 直接用 WebCrypto（零外部依赖、不读设备文件）。与 `init/secrets.ts:randomKey` 同源。
 */
export function generateRedisPassword(bytes = 24): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let hex = "";
    for (const b of buf) hex += b.toString(16).padStart(2, "0");
    return hex;
}

/** {@link createLocalRedis} 的注入点与参数。 */
export interface CreateLocalRedisOptions {
    /** Judge 运行目录（`redis.conf` 落在其中）。 */
    dir: string;
    runner: CommandRunner;
    /** 容器名；缺省 {@link DEFAULT_REDIS_CONTAINER}。 */
    containerName?: string;
    /** 宿主机端口；缺省 {@link DEFAULT_REDIS_PORT}。 */
    port?: number;
    /** Redis 镜像；缺省 {@link DEFAULT_JUDGE_REDIS_IMAGE}。 */
    redisImage?: string;
    dockerBin?: string;
    /** 端口占用探测（`ss -ltnH` 的等价注入点）；供测试替换。 */
    probePortInUse?: (port: number) => Promise<boolean>;
}

/** {@link createLocalRedis} 的结果（三条连接串 + 元信息）。 */
export interface CreateLocalRedisResult {
    containerName: string;
    port: number;
    /**
     * 三方连接串：
     * - `coreUrl`：**宿主机**上的 noj-core 用（`127.0.0.1`）；
     * - `runtimeUrl`：**容器内**的 Judge 用（`host.docker.internal`）；
     * - `checkUrl`：本工具自检用（等于 `coreUrl`）。
     */
    coreUrl: string;
    runtimeUrl: string;
    checkUrl: string;
    /** 容器标签值，便于上层记录"这是本工具管理的 Redis"。 */
    componentLabel: string;
    /** 是否复用了既有容器（true）还是新建（false）。 */
    reused: boolean;
}

/**
 * 为本机 Judge 创建（或复用）一个**仅绑定回环地址**的 Redis。
 *
 * ## 安全边界
 *
 * 1. **只管理自己创建的容器**：同名容器存在时，检查
 *    `com.neuro-oj.component` 标签是否为 {@link REDIS_COMPONENT_LABEL}；
 *    不是则**拒绝**，绝不 `rm`/`stop`/修改别人的容器；
 * 2. **端口必须空闲**：被占用即拒绝，不覆盖既有服务；
 * 3. **只绑定 `127.0.0.1`**：`--publish 127.0.0.1:<port>:6379`——Redis 带口令
 *    但**绝不暴露到公网**；
 * 4. **随机口令**：48 位 hex，写进 600 权限的 `redis.conf`；
 * 5. **独立数据卷**：`<container>-data`，删容器不丢数据。
 *
 * ## 为什么 coreUrl 与 runtimeUrl 不同
 *
 * Judge 跑在**容器内**、Redis 在**宿主机**上：
 * - `coreUrl` 给宿主机上的 noj-core 用 → `127.0.0.1:<port>`；
 * - `runtimeUrl` 给容器内的 Judge 用 → `host.docker.internal:<port>`。
 * 混用会导致"本机能连、容器内连不上"这类难查故障。
 */
export async function createLocalRedis(
    opts: CreateLocalRedisOptions,
): Promise<CreateLocalRedisResult> {
    const containerName = opts.containerName ?? DEFAULT_REDIS_CONTAINER;
    const port = opts.port ?? DEFAULT_REDIS_PORT;
    const dockerBin = opts.dockerBin ?? "docker";
    const image = opts.redisImage ?? DEFAULT_JUDGE_REDIS_IMAGE;

    // ---- 校验（在任何 docker 调用之前）----
    assertRedisContainerName(containerName);
    assertRedisPort(port);

    const runner = opts.runner;

    // ---- 1. 已存在同名容器？----
    const inspect = await runner.run(dockerBin, [
        "container",
        "inspect",
        containerName,
    ]);
    if (inspect.code === 0) {
        // 必须确认是我们创建的：读标签
        const labelRes = await runner.run(dockerBin, [
            "container",
            "inspect",
            "--format",
            `{{ index .Config.Labels "com.neuro-oj.component" }}`,
            containerName,
        ]);
        const label = labelRes.stdout.trim();
        if (label !== REDIS_COMPONENT_LABEL) {
            throw new UsageError(
                `Redis 容器名已被其他容器占用：${containerName}；` +
                    `不会删除或修改它，请换名或选择连接已有 Redis`,
            );
        }
        // 是本工具的容器 → 复用。连接串需要读回既有口令，故从 redis.conf 取。
        const password = await readRedisPassword(opts.dir);
        if (password === "") {
            throw new Error(
                `检测到本工具创建的 Redis，但缺少连接信息：${opts.dir}/redis.conf；` +
                    `请手动恢复后再继续`,
            );
        }
        return redisUrls(containerName, port, password, true);
    }

    // ---- 2. 端口必须空闲 ----
    const inUse = opts.probePortInUse !== undefined
        ? await opts.probePortInUse(port)
        : await defaultProbePortInUse(runner, port);
    if (inUse) {
        throw new Error(
            `本机 Redis 端口已被占用：127.0.0.1:${port}；` +
                `请换一个端口，或选择连接已有 Redis`,
        );
    }

    // ---- 3. 生成口令并写 600 配置 ----
    const password = generateRedisPassword();
    if (password === "") throw new Error("无法生成本机 Redis 密码");
    const configFile = join(opts.dir, "redis.conf");
    // 先建目录（否则 writeTextFile 会失败）；判官目录由调用方保证存在亦可。
    await Deno.mkdir(opts.dir, { recursive: true });
    // `umask 077` + 显式 chmod：配置含口令，任何中间态都不能 world-readable。
    const prevUmask = Deno.umask(0o077);
    try {
        await Deno.writeTextFile(
            configFile,
            `appendonly yes\nrequirepass ${password}\n`,
        );
        await Deno.chmod(configFile, 0o600);
    } finally {
        Deno.umask(prevUmask);
    }

    // ---- 4. 创建容器（参数为纯数组，绝不拼 shell 字符串）----
    const created = await runner.run(dockerBin, [
        "run",
        "-d",
        "--name",
        containerName,
        "--label",
        `com.neuro-oj.component=${REDIS_COMPONENT_LABEL}`,
        "--label",
        `com.neuro-oj.managed-by=${REDIS_MANAGED_BY_LABEL}`,
        "--restart",
        "unless-stopped",
        // **仅绑定回环**：Redis 带口令，但绝不暴露到公网。
        "--publish",
        `127.0.0.1:${port}:6379`,
        "--volume",
        `${containerName}-data:/data`,
        "--volume",
        `${configFile}:/usr/local/etc/redis/redis.conf:ro`,
        image,
        "redis-server",
        "/usr/local/etc/redis/redis.conf",
    ]);
    if (created.code !== 0) {
        throw new Error(
            `本机 Redis 创建失败；端口可能被占用或 Docker 权限不足。原有服务未被修改` +
                (created.stderr.trim() === ""
                    ? ""
                    : `：${created.stderr.trim()}`),
        );
    }

    return redisUrls(containerName, port, password, false);
}

/** 组装三条连接串。 */
function redisUrls(
    containerName: string,
    port: number,
    password: string,
    reused: boolean,
): CreateLocalRedisResult {
    const coreUrl = `redis://:${password}@127.0.0.1:${port}/0`;
    // Judge 在容器内，"宿主机"要从容器的视角写：`host.docker.internal`。
    const runtimeUrl = `redis://:${password}@host.docker.internal:${port}/0`;
    return {
        containerName,
        port,
        coreUrl,
        runtimeUrl,
        checkUrl: coreUrl,
        componentLabel: REDIS_COMPONENT_LABEL,
        reused,
    };
}

/** 从既有 `redis.conf` 读回口令（复用容器时用；读不到返回空串）。 */
async function readRedisPassword(dir: string): Promise<string> {
    try {
        const text = await Deno.readTextFile(join(dir, "redis.conf"));
        const m = /^requirepass\s+(\S+)$/m.exec(text);
        return m?.[1] ?? "";
    } catch {
        return "";
    }
}

/**
 * 缺省的端口占用探测。
 *
 * 优先 `ss`，回落 `lsof`；两者都不可用时**保守地返回 false**
 * （探测不到就当未占用，随后 docker run 会给出真实错误）。
 */
async function defaultProbePortInUse(
    runner: CommandRunner,
    port: number,
): Promise<boolean> {
    const ss = await runner.run("ss", ["-ltnH"]);
    if (ss.code === 0) {
        // 只查**第 4 列**
        // （ss 的本地地址列，如 `127.0.0.1:16379`），且 `:PORT` 必须在**该字段末尾**。
        //
        // 两点都不能省：
        // 1. 只查第 4 列——否则远端地址列（`0.0.0.0:*`）或其它列可能误命中；
        // 2. 要求字段**结尾**匹配——否则 1637 会命中 16379。
        // 我第一版在整行上做正则，实测对 `LISTEN 0 4096 0.0.0.0:6379 0.0.0.0:*`
        // 这类真实输出判断错误。
        return ss.stdout.split("\n").some((line) => {
            const fields = line.trim().split(/\s+/);
            const local = fields[3] ?? "";
            return local.endsWith(`:${port}`);
        });
    }
    const lsof = await runner.run("lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
    ]);
    return lsof.code === 0 && lsof.stdout.trim() !== "";
}
