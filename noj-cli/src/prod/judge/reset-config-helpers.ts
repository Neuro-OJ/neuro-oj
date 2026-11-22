/**
 * `judge reset-config` 的纯解析与局部修改辅助函数：
 * - Redis URL 严格解析、本机模式校验与无口令泄露诊断；
 * - Judge Compose 实际生效环境变量提取、环境变量展开与局部 YAML 更新；
 * - 文件预暂存原语与 Worker 优雅停止宽限期计算。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §6.2 多副本约束）。
 */

import { basename, dirname, join } from "@std/path";
import { isMap, isSeq, parseDocument, Scalar } from "yaml";
import { UsageError } from "../../util/args.ts";

/** 解析后的 Redis 连接参数（口令经独立字段传递，绝不进命令行）。 */
export interface ParsedRedisConnection {
    tls: boolean;
    host: string;
    port: number;
    db: number;
    username?: string;
    password?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 判定主机名是否为本机回环地址。 */
export function isLoopbackHost(host: string): boolean {
    return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function decodeCredentialComponent(raw: string, label: string): string {
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        throw new UsageError(`${label} 认证段包含无效百分号编码`);
    }
    if (/[\r\n\0]/.test(decoded)) {
        throw new UsageError(`${label} 认证信息包含非法控制字符`);
    }
    return decoded;
}

/**
 * 严格解析并校验 Redis URL；失败时只报告字段名与错误类别，绝不回显原始 URL 或凭据。
 */
export function parseRedisConnection(
    rawUrl: string,
    label: string,
): ParsedRedisConnection {
    if (/[\r\n\0]/.test(rawUrl)) {
        throw new UsageError(`${label} 包含非法控制字符`);
    }
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new UsageError(
            `${label} 格式无效（若口令包含 / @ : 等特殊字符，请先进行百分号编码）`,
        );
    }
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
        throw new UsageError(`${label} 必须使用 redis:// 或 rediss:// 协议`);
    }
    if (url.hash !== "") {
        throw new UsageError(
            `${label} 格式无效（若口令包含 # / @ : 等特殊字符，请先进行百分号编码）`,
        );
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "") {
        throw new UsageError(`${label} 缺少主机名`);
    }
    let port = 6379;
    if (url.port !== "") {
        if (!/^\d+$/.test(url.port)) {
            throw new UsageError(`${label} 端口无效（必须为 1..65535 的整数）`);
        }
        port = Number.parseInt(url.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new UsageError(`${label} 端口无效（必须为 1..65535 的整数）`);
        }
    }
    let db = 0;
    if (url.pathname !== "" && url.pathname !== "/") {
        const match = /^\/(\d+)$/.exec(url.pathname);
        if (!match) {
            throw new UsageError(`${label} 数据库路径必须为 /<非负整数>`);
        }
        db = Number.parseInt(match[1]!, 10);
        if (!Number.isSafeInteger(db)) {
            throw new UsageError(`${label} 数据库编号超出范围`);
        }
    }
    const username = url.username !== ""
        ? decodeCredentialComponent(url.username, label)
        : undefined;
    const password = url.password !== ""
        ? decodeCredentialComponent(url.password, label)
        : undefined;

    return {
        tls: url.protocol === "rediss:",
        host,
        port,
        db,
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
    };
}

function sameEndpointMeta(
    a: ParsedRedisConnection,
    b: ParsedRedisConnection,
): boolean {
    return (
        a.tls === b.tls &&
        a.port === b.port &&
        a.db === b.db &&
        a.username === b.username &&
        a.password === b.password
    );
}

/**
 * 在停机前同时校验 `REDIS_URL` 与（若配置的）`REDIS_CHECK_URL`，并选出宿主机可用的连接。
 *
 * 仅当 `REDIS_CHECK_URL` 与 Worker 生效的 `REDIS_URL` 在 TLS、端口、DB 与认证凭据上完全一致，
 * 且主机名相同或属于可确认的本机别名对（`host.docker.internal` ↔ 回环地址）时才接受；
 * 拒绝指向旧实例或不同逻辑库的过期健康检查地址。
 */
export function resolveHostRedisConnection(
    env: Record<string, string>,
): ParsedRedisConnection {
    const mainConn = parseRedisConnection(env["REDIS_URL"] ?? "", "REDIS_URL");
    const rawCheck = (env["REDIS_CHECK_URL"] ?? "").trim();
    if (rawCheck === "") {
        return mainConn;
    }
    const checkConn = parseRedisConnection(rawCheck, "REDIS_CHECK_URL");
    if (sameEndpointMeta(mainConn, checkConn)) {
        const mainHost = mainConn.host.toLowerCase();
        const checkHost = checkConn.host.toLowerCase();
        if (mainHost === checkHost) {
            return mainConn;
        }
        if (mainHost === "host.docker.internal" && isLoopbackHost(checkHost)) {
            return checkConn;
        }
        // 向后兼容历史 `judge install --redis-mode local` 把两者写反的配置。
        if (isLoopbackHost(mainHost) && checkHost === "host.docker.internal") {
            return mainConn;
        }
    }
    throw new UsageError(
        "REDIS_CHECK_URL 与 Worker 实际生效的 REDIS_URL 不一致（主机、端口、数据库、TLS 或认证信息不同）；" +
            "请同步更新或清空 .env.judge 中的 REDIS_CHECK_URL 后重试",
    );
}

function lookupComposeVar(
    name: string,
    envFileValues: Record<string, string>,
    hostEnv: Record<string, string>,
): string | undefined {
    // 与 Docker Compose 一致：宿主环境变量优先级高于 --env-file。
    if (Object.prototype.hasOwnProperty.call(hostEnv, name)) {
        return hostEnv[name];
    }
    if (Object.prototype.hasOwnProperty.call(envFileValues, name)) {
        return envFileValues[name];
    }
    return undefined;
}

function expandComposeValue(
    raw: string,
    envFileValues: Record<string, string>,
    hostEnv: Record<string, string>,
): string {
    return raw.replace(
        /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (
            match,
            bracedName: string | undefined,
            op: string | undefined,
            operand: string | undefined,
            bareName: string | undefined,
        ) => {
            if (match === "$$") return "$";
            const name = bracedName ?? bareName!;
            const val = lookupComposeVar(name, envFileValues, hostEnv);
            const isSet = val !== undefined;
            const isNonEmpty = val !== undefined && val !== "";
            switch (op) {
                case ":-":
                    return isNonEmpty ? val : (operand ?? "");
                case "-":
                    return isSet ? val : (operand ?? "");
                case ":+":
                    return isNonEmpty ? (operand ?? "") : "";
                case "+":
                    return isSet ? (operand ?? "") : "";
                case ":?":
                    if (!isNonEmpty) {
                        throw new UsageError(
                            `Compose 变量 ${name} 未设置或为空：${
                                operand || "缺少必需变量"
                            }`,
                        );
                    }
                    return val;
                case "?":
                    if (!isSet) {
                        throw new UsageError(
                            `Compose 变量 ${name} 未设置：${
                                operand || "缺少必需变量"
                            }`,
                        );
                    }
                    return val;
                default:
                    return val ?? "";
            }
        },
    );
}

function scalarText(node: unknown): string {
    if (node instanceof Scalar) {
        return node.value === null || node.value === undefined
            ? ""
            : String(node.value);
    }
    if (node === null || node === undefined) return "";
    return String(node);
}

/** 检测 `services.judge` 是否配置了 `env_file`（纯静态预演无法展开外部 env_file）。 */
export function hasJudgeComposeEnvFile(composeText: string): boolean {
    const doc = parseDocument(composeText);
    if (doc.errors.length > 0) return false;
    const envFileNode = doc.getIn(["services", "judge", "env_file"], true);
    return envFileNode !== undefined && envFileNode !== null;
}

/**
 * 解析 `docker compose ... config` 的权威标准输出，提取 `services.judge.environment`。
 * 若 YAML 无效或缺少 `services.judge.environment` 则抛出错误，阻止停机或写 Redis。
 */
export function parseResolvedComposeEnv(
    resolvedYaml: string,
): Record<string, string> {
    const doc = parseDocument(resolvedYaml);
    if (doc.errors.length > 0) {
        throw new Error(
            `Compose 解析输出 YAML 无效：${doc.errors[0]!.message}`,
        );
    }
    const envNode = doc.getIn(["services", "judge", "environment"], true);
    if (isMap(envNode)) {
        const out: Record<string, string> = {};
        for (const pair of envNode.items) {
            const key = scalarText(pair.key);
            if (key === "") continue;
            out[key] = scalarText(pair.value);
        }
        return out;
    }
    if (isSeq(envNode)) {
        const out: Record<string, string> = {};
        for (const item of envNode.items) {
            const text = scalarText(item);
            const eq = text.indexOf("=");
            if (eq > 0) {
                out[text.slice(0, eq)] = text.slice(eq + 1);
            } else if (text !== "") {
                out[text] = "";
            }
        }
        return out;
    }
    throw new Error(
        "Compose 解析输出缺少 services.judge.environment，无法确定 Worker 实际环境配置",
    );
}

/**
 * 静态读取 `docker-compose.judge.yml` 中 `services.judge.environment` 注入 Worker 的环境变量
 * （宿主环境变量优先级高于 `envFileValues`）。用于无需子进程的 `--dry-run` 与 `judgeStop`。
 */
export function readJudgeComposeEnv(
    composeText: string,
    envFileValues: Record<string, string>,
    hostEnv: Record<string, string> = {},
): Record<string, string> | null {
    const doc = parseDocument(composeText);
    if (doc.errors.length > 0) return null;
    const envNode = doc.getIn(["services", "judge", "environment"], true);
    if (isMap(envNode)) {
        const out: Record<string, string> = {};
        for (const pair of envNode.items) {
            const key = scalarText(pair.key);
            if (key === "") continue;
            const rawVal = scalarText(pair.value);
            out[key] = expandComposeValue(rawVal, envFileValues, hostEnv);
        }
        return out;
    }
    if (isSeq(envNode)) {
        const out: Record<string, string> = {};
        for (const item of envNode.items) {
            const text = scalarText(item);
            const eq = text.indexOf("=");
            if (eq > 0) {
                const key = text.slice(0, eq);
                out[key] = expandComposeValue(
                    text.slice(eq + 1),
                    envFileValues,
                    hostEnv,
                );
            } else if (text !== "") {
                const passed = lookupComposeVar(text, envFileValues, hostEnv);
                if (passed !== undefined) out[text] = passed;
            }
        }
        return out;
    }
    return null;
}

/**
 * 仅就地更新 `docker-compose.judge.yml` 中 `services.judge.environment` 的指定键，
 * 保留既有注释、自定义网络（如 `external: true`）与卷等部署定制。
 */
export function patchJudgeComposeEnvironment(
    composeText: string,
    updates: Record<string, string>,
): string {
    const entries = Object.entries(updates);
    if (entries.length === 0) return composeText;

    const doc = parseDocument(composeText);
    if (doc.errors.length > 0) {
        throw new UsageError(
            `Compose 配置 YAML 解析失败：${doc.errors[0]!.message}`,
        );
    }
    const envNode = doc.getIn(["services", "judge", "environment"], true);
    if (isMap(envNode)) {
        for (const [key, value] of entries) {
            const existing = envNode.get(key, true);
            if (existing instanceof Scalar) {
                existing.value = value;
                existing.type = Scalar.QUOTE_DOUBLE;
            } else {
                const scalar = doc.createNode(value);
                if (scalar instanceof Scalar) scalar.type = Scalar.QUOTE_DOUBLE;
                envNode.set(key, scalar);
            }
        }
        return doc.toString();
    }
    if (isSeq(envNode)) {
        for (const [key, value] of entries) {
            const idx = envNode.items.findIndex((item) => {
                const text = scalarText(item);
                return text === key || text.startsWith(`${key}=`);
            });
            const entryText = `${key}=${value}`;
            if (idx >= 0) {
                const item = envNode.items[idx];
                if (item instanceof Scalar) {
                    item.value = entryText;
                } else {
                    envNode.set(idx, entryText);
                }
            } else {
                envNode.add(entryText);
            }
        }
        return doc.toString();
    }
    throw new UsageError(
        "Compose 配置缺少 services.judge.environment，无法就地更新调度参数",
    );
}

/**
 * 将内容写入同目录独占临时文件（权限 `mode` + `syncData` + 显式 `chmod`），
 * 供「停机清锁前先校验可写性，清锁后再原子替换」使用。
 */
export async function stageFileAtomic(
    destPath: string,
    content: string,
    mode: number,
    label: string,
): Promise<string> {
    const tmpPath = join(
        dirname(destPath),
        `.${basename(destPath)}.tmp-${Deno.pid}-${crypto.randomUUID()}`,
    );
    const bytes = new TextEncoder().encode(content);
    let file: Deno.FsFile | null = null;
    try {
        file = await Deno.open(tmpPath, {
            createNew: true,
            write: true,
            mode,
        });
        let offset = 0;
        while (offset < bytes.byteLength) {
            const n = await file.write(bytes.subarray(offset));
            if (n <= 0) {
                throw new Error(`写入暂存文件失败（${label}）`);
            }
            offset += n;
        }
        await file.syncData();
        file.close();
        file = null;
        await Deno.chmod(tmpPath, mode);
        return tmpPath;
    } catch (err) {
        if (file !== null) {
            try {
                file.close();
            } catch {
                // 忽略关闭异常
            }
        }
        await Deno.remove(tmpPath).catch(() => {});
        throw new Error(
            `暂存 ${label} 失败（${(err as Error).message}）`,
        );
    }
}

/**
 * 计算 `docker compose stop -t <sec>` 宽限期，确保覆盖 Worker 的优雅排空与退场清理预算：
 * 与 `noj-judge/src/config.rs::drain_timeout_secs()` (`max(30, download + 30)`)
 * 再叠加退出前兜底容器清扫与 abort join 余量（+30s），默认 120s。
 */
export function computeJudgeStopTimeoutSeconds(
    effectiveEnv: Record<string, string>,
): number {
    const raw = (effectiveEnv["SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT"] ?? "").trim();
    const parsed = /^[1-9][0-9]*$/.test(raw) ? Number.parseInt(raw, 10) : 60;
    const drainTimeout = Math.max(30, parsed + 30);
    return Math.max(120, drainTimeout + 30);
}
