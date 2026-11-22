/**
 * 生产生命周期的共享步骤：compose 编排 + 前置校验。
 *
 * **命令入口留在 `lifecycle.ts`**，本模块只放被多个动作（install / start /
 * update 等）共享的"步骤"；logs 着色契约见 `logs-color.ts`，uninstall 前置与
 * 安装目录守卫见 `uninstall-guards.ts`。
 *
 * ## 边界
 *
 * 1. `up` 走 `prod/compose.ts` 的命名封装；`stop`/`pull` 等裸子命令经
 *    {@link runComposeSub} 用 `composeArgs` 组装纯参数数组再交给 runner，
 *    绝不拼 shell 字符串。
 * 2. **runner 不替调用方打印**：compose 输出经
 *    {@link composeOutputText} 交回调用方，由其写往 stderr / 注入的 io。
 * 3. **一切外部命令经注入的 {@link CommandRunner}**；文件系统访问只有 stat/read，
 *    测试用临时目录（不碰真实部署目录）。
 * 4. 前置校验复用 `checkEnvFileMode` / `checkRequiredValues` /
 *    `judgeEnabledError`，本模块不重写一套。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

// ---------------- 共享文件原语 ----------------

import { join } from "@std/path";
import {
    checkEnvFileMode,
    judgeEnabledError,
} from "../../core/config-schema.ts";
import { writeEnvFileAtomic } from "../../core/env-file.ts";
import { type CommandRunner } from "../../runtime/command.ts";
import {
    backupPassphrasePath,
    checkJudgeSocket,
    checkPortValue,
    checkRequiredValues,
    ensureBackupPassphrase,
    toEntries,
} from "../config.ts";
import { type EnvValues, type RequiredValuesReport } from "../config.ts";
import {
    composeArgs,
    composeConfig,
    PROD_COMPOSE_FILE,
    PROD_ENV_FILE,
} from "../compose.ts";
import { type ComposeOptions, type ComposeResult } from "../compose.ts";
import { isFile } from "../../util/fs.ts";
import { readEnvValues } from "../../core/env-file.ts";

/**
 * 读文件的八进制权限串（`stat -c %a` 的等价）。
 *
 * 返回 `{ isFile, mode }`：`mode` 读不出时为 null，交由
 * {@link checkEnvFileMode} 产出报错。
 */
export async function statMode(path: string): Promise<{
    isFile: boolean;
    mode: string | null;
}> {
    try {
        const st = await Deno.stat(path);
        return {
            isFile: st.isFile,
            mode: ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0"),
        };
    } catch {
        return { isFile: false, mode: null };
    }
}

/**
 * 配置校验入口：**先** `judgeEnabledError` → **再** `checkRequiredValues`。
 *
 * 顺序是硬要求：`validateEnv`（`checkRequiredValues` 的
 * 第一步）装不下 `JUDGE_ENABLED` 的枚举错误，非法值必须先被 `judgeEnabledError`
 * 拒绝。judge **未设置/空串 = 启用**。
 */
export function assertConfiguration(env: EnvValues): RequiredValuesReport {
    const judgeError = judgeEnabledError(env["JUDGE_ENABLED"]);
    if (judgeError !== null) throw new Error(judgeError);
    const report = checkRequiredValues(env);
    if (!report.ok) {
        throw new Error("生产配置校验失败：\n" + report.errors.join("\n"));
    }
    return report;
}

// ---------------- prepare_and_check ----------------

/** {@link prepareAndCheck} 的成功分支：已定位并校验的安装环境。 */
export interface PreparedEnvironment {
    ok: true;
    /** 归一化安装目录（无尾斜杠）。 */
    dir: string;
    envFile: string;
    composeFile: string;
    /** `.env.prod` 的键值（含未设置键的 undefined）。 */
    env: EnvValues;
    /** judge 是否启用（决定 compose 是否带 `--profile judge`）。 */
    judge: boolean;
}

/** {@link prepareAndCheck} 的失败分支：面向用户的错误文本。 */
export interface PrepareFailure {
    ok: false;
    error: string;
}

/** {@link prepareAndCheck} 的结果。 */
export type PrepareResult = PreparedEnvironment | PrepareFailure;

/** compose 配置无效的报错前缀。 */
export const COMPOSE_CONFIG_INVALID_HINT =
    "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件";

/**
 * {@link prepareAndCheck} 的注入点。
 *
 * `runner` 必填：步骤 6（`compose config --quiet`）必须真实执行 compose 解析。
 * 步骤 4/5 的**环境探测**（socket / 端口占用）各留一个注入点，缺省即
 * "已跳过"/"无 lsof"，测试与无真实机器场景都不会误触。
 */
export interface PrepareOptions {
    /** 生产安装目录（已归一化）。 */
    dir: string;
    /** 外部命令注入点（docker，步骤 6）。 */
    runner: CommandRunner;
    /**
     * 步骤 4：judge socket 存在性探测（{@link checkJudgeSocket} 的注入点）。
     *
     * 仅在 judge 启用时被调用；judge 关闭即「已跳过」，**不探测**。
     */
    socketExists?: (path: string) => Promise<boolean>;
    /**
     * 步骤 5：端口占用探测（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 的注入点）。
     *
     * 缺省不探测：`checkPortValue` 的端口*取值*校验（纯计算）始终执行，只有
     * `lsof` 这类真实环境探测被延后到注入方。
     */
    probePort?: (port: number) => Promise<boolean>;
    /** 步骤 5 端口冲突告警的写出点；缺省丢弃（调用方决定 stdout/stderr）。 */
    write?: StepSink;
}

/**
 * 生产命令的前置校验：compose 文件存在 + 配置六步。
 *
 * docker 存在性 / daemon / buildx 属环境探测，不在此检查。
 *
 * | # | 检查 | 实现 | 环境探测的注入点 |
 * | --- | --- | --- | --- |
 * | — | compose 文件存在 | {@link isFile} | 无 |
 * | 1 | `.env.prod` 存在 | {@link isFile} | 无 |
 * | 2 | `.env.prod` 权限 600/400 | {@link statMode} + `checkEnvFileMode` | 无 |
 * | 3 | 必需键 | {@link assertConfiguration} | 无 |
 * | 4 | judge socket（judge 关闭时跳过） | {@link checkJudgeSocket} | `socketExists`（缺省不探测） |
 * | 5 | 端口取值；`lsof` 占用告警 | {@link checkPortValue} | `probePort`（缺省不探测） |
 * | 6 | `compose config --quiet` | {@link composeConfig} | `runner`（必填） |
 *
 * 第 4/5 步的真实环境探测通过注入点表达——测试注入 fake，生产注入真实实现；
 * 不注入即跳过探测。
 *
 * **零副作用**：步骤 1–5 不调用任何 docker；唯一的 docker 调用是第 6 步的
 * `compose config`（**只读解析**，非变更命令）。任一失败都在任何 `up`/`stop`/
 * `down` 之前返回错误，由命令入口转成退出码 1。
 */
export async function prepareAndCheck(
    opts: PrepareOptions,
): Promise<PrepareResult> {
    const dir = opts.dir;
    const envFile = join(dir, PROD_ENV_FILE);
    const composeFile = join(dir, PROD_COMPOSE_FILE);

    // ---- compose 文件存在（先于配置校验）----
    if (!(await isFile(composeFile))) {
        return {
            ok: false,
            error: `找不到生产 Compose 文件：${composeFile}，请先执行 install`,
        };
    }

    // ---- 1. [[ -f "$ENV_FILE" ]]----
    if (!(await isFile(envFile))) {
        return {
            ok: false,
            error: `找不到生产配置：${envFile}，请先执行 install`,
        };
    }

    // ---- 2. check_file_permissions----
    const { mode } = await statMode(envFile);
    const verdict = checkEnvFileMode(mode, envFile);
    if (verdict.kind !== "ok") return { ok: false, error: verdict.message };

    // ---- 3. check_required_values----
    const env = await readEnvValues(envFile);
    let report: RequiredValuesReport;
    try {
        report = assertConfiguration(env);
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }

    // ---- 4. judge socket；judge 关闭即跳过 ----
    if (report.judgeEnabled) {
        const socket = await checkJudgeSocket(env, {
            socketExists: opts.socketExists,
        });
        if (!socket.ok) {
            return {
                ok: false,
                error: socket.error ?? "Judge Docker socket 校验失败",
            };
        }
    }

    // ---- 5. check_port_value：取值恒校验，占用探测经注入点 ----
    const port = await checkPortValue(env);
    if (port.error !== null) return { ok: false, error: port.error };
    if (opts.probePort !== undefined && (await opts.probePort(port.port))) {
        opts.write?.(port.warning ?? PORT_CONFLICT_HINT(port.port));
    }

    // ---- 6. compose config --quiet（只读解析）----
    // `--quiet`：只判定可解析性，不把渲染结果写进 stdout。
    const composeOptions: ComposeOptions = {
        composeFile,
        // 项目目录固定为安装目录：相对挂载不随调用时的工作目录变化。
        projectDirectory: dir,
        envFile,
        judge: report.judgeEnabled,
    };
    const configCheck = await composeConfig(opts.runner, {
        ...composeOptions,
        quiet: true,
    });
    if (!Array.isArray(configCheck) && configCheck.code !== 0) {
        const detail = configCheck.stderr.trim();
        return {
            ok: false,
            error: detail === ""
                ? COMPOSE_CONFIG_INVALID_HINT
                : `${COMPOSE_CONFIG_INVALID_HINT}：${detail}`,
        };
    }

    return {
        ok: true,
        dir,
        envFile,
        composeFile,
        env,
        judge: report.judgeEnabled,
    };
}

// ---------------- compose 编排 ----------------

/**
 * 执行一条没有命名封装的裸 compose 子命令（`stop` / `pull` 等）。
 *
 * 必须在调用点用 `Array.isArray` 收窄 `ComposeResult`。
 */
export function runComposeSub(
    runner: CommandRunner,
    options: ComposeOptions,
    command: string[],
): Promise<ComposeResult> {
    return runner.run("docker", composeArgs({ ...options, command }));
}

/**
 * 把 compose 输出转成待写文本（runner 不打印）。
 *
 * `dryRun` 的参数数组无输出，返回空串；否则 stdout 在前、stderr 在后，
 * 由调用方决定写往 stdout 还是 stderr。
 */
export function composeOutputText(result: ComposeResult): string {
    if (Array.isArray(result)) return "";
    return result.stdout + result.stderr;
}

/** 步骤输出的汇聚点：人类可读诊断，调用方决定去 stdout / stderr。 */
export type StepSink = (text: string) => void;

// ---------------- 备份口令步骤（install / update 共用） ----------------

/** 口令新生成时的告警文案。 */
export const PASSPHRASE_CARRY_HINT =
    "请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照";

/** {@link ensureCommandPassphrase} 的输入。 */
export interface PassphraseStepOptions {
    /** `.env.prod` 路径（回填目标）。 */
    envFile: string;
    /** 当前 `.env.prod` 键值（`NOJ_BACKUP_PASSPHRASE_FILE` 参与选目标路径）。 */
    env: EnvValues;
    /** 进程环境快照（`NOJ_BACKUP_PASSPHRASE_FILE` 抑制回填且优先选路径）。 */
    processEnv: Record<string, string | undefined>;
    /** `--passphrase-file` 旗标（优先级最高，但**不**抑制回填）。 */
    passphraseFile?: string;
    /** 口令新生成时的告警汇聚点。 */
    warn?: (message: string) => void;
}

/** {@link ensureCommandPassphrase} 的结果。 */
export interface PassphraseStepResult {
    /** 口令文件路径（无论新建还是复用）。 */
    path: string;
    /** 本次是否新生成口令文件。 */
    created: boolean;
    /** 回填后**重新读取**的 env（未回填时为传入的 `env` 原值）。 */
    env: EnvValues;
    /** 面向用户的失败文案；成功为 null。 */
    error: string | null;
}

/**
 * 备份口令的命令级装配，install（第 4 步）与 update（升级序列第 2 步）共用：
 *
 * 1. 目标路径 = `backupPassphrasePath({ flag, explicit: 进程环境, configured: 配置文件 })`
 *    ——四级优先；
 * 2. `configuredFromEnv` **只**看进程环境是否设置了 `NOJ_BACKUP_PASSPHRASE_FILE`；
 *    `--passphrase-file` 旗标不抑制回填（见 `config.ts` 的 JSDoc）；
 * 3. 需要回填时经 `writeEnvFileAtomic` 就地改写（保留注释与顺序）并**重新读取**，
 *    让调用方拿到回填后的真实值；
 * 4. 新生成时转出告警——口令丢失等于备份不可恢复，静默不是选项。
 *
 * 失败以 `error` 返回而非抛错：调用方（install 抛错 / update 转退出码 1）各自决定。
 */
export async function ensureCommandPassphrase(
    opts: PassphraseStepOptions,
): Promise<PassphraseStepResult> {
    const explicit = opts.processEnv["NOJ_BACKUP_PASSPHRASE_FILE"];
    const target = backupPassphrasePath({
        flag: opts.passphraseFile,
        explicit,
        configured: opts.env["NOJ_BACKUP_PASSPHRASE_FILE"],
    });
    const ensured = await ensureBackupPassphrase(opts.env, {
        targetFile: target,
        configuredFromEnv: (explicit ?? "") !== "",
    });
    if (ensured.error !== null) {
        return {
            path: ensured.path,
            created: false,
            env: opts.env,
            error: ensured.error,
        };
    }
    if (ensured.created) opts.warn?.(PASSPHRASE_CARRY_HINT);

    let env = opts.env;
    if (ensured.envUpdate !== null) {
        await writeEnvFileAtomic(opts.envFile, toEntries(ensured.envUpdate));
        env = await readEnvValues(opts.envFile);
    }
    return { path: ensured.path, created: ensured.created, env, error: null };
}

/**
 * 健康等待 + 反向代理刷新，两段 compose：
 *
 * 1. `up -d --wait --wait-timeout 180 --remove-orphans`；
 * 2. `up -d --force-recreate --no-deps nginx`。
 *
 * install 与 start 共用本函数。
 *
 * 失败**不抛错**：返回 `{ ok:false, error }`，由命令入口决定退出码（install 抛错、
 * 生命周期命令返回 1）。返回值同时带第一段
 * `code`（成功真值），供 install 结果如实记录 `composeUpCode`——不再硬编码 0。
 */
export async function waitForStack(
    runner: CommandRunner,
    options: ComposeOptions,
    write: StepSink,
): Promise<WaitForStackResult> {
    write("\n== 等待服务健康 ==\n");

    const healthy = await runComposeSub(runner, options, [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        WAIT_TIMEOUT_SECONDS,
        "--remove-orphans",
    ]);
    write(composeOutputText(healthy));
    if (!Array.isArray(healthy) && healthy.code !== 0) {
        return { ok: false, error: WAIT_FAILURE_HINT, code: healthy.code };
    }

    const nginx = await runComposeSub(runner, options, [
        "up",
        "-d",
        "--force-recreate",
        "--no-deps",
        "nginx",
    ]);
    write(composeOutputText(nginx));
    if (!Array.isArray(nginx) && nginx.code !== 0) {
        return {
            ok: false,
            error: NGINX_REFRESH_FAILURE_HINT,
            code: nginx.code,
        };
    }

    write("✓ 生产服务已通过 Compose 健康检查\n");
    return { ok: true, error: null, code: 0 };
}

/**
 * {@link waitForStack} 的结果。
 *
 * `code` 是**第一段** `up -d --wait --wait-timeout 180 --remove-orphans` 的
 * compose 退出码：成功恒为 0；失败时即真实非零码（同时 `ok=false` 且 `error`
 * 为失败文案）。调用方据此填写 `InstallResult.composeUpCode`，
 * 而不是硬编码 `0`。
 */
export interface WaitForStackResult {
    ok: boolean;
    error: string | null;
    /** 第一段 `up` 的 compose 退出码（成功即 0）。 */
    code: number;
}

/** `--wait-timeout` 的秒数。 */
export const WAIT_TIMEOUT_SECONDS = "180";

/** 健康等待失败文案。 */
export const WAIT_FAILURE_HINT =
    "服务启动或健康检查失败，请执行 status 和 logs 排查";

/** 反向代理刷新失败文案。 */
export const NGINX_REFRESH_FAILURE_HINT =
    "反向代理刷新失败，请执行 status 和 logs 排查";

/**
 * 端口占用告警文案。
 *
 * 缺省探测关闭时不会用到；`checkPortValue` 自身也产出同形文案，此处供
 * {@link prepareAndCheck} 在**注入** `probePort` 时统一措辞。
 */
export function PORT_CONFLICT_HINT(port: number): string {
    return `NGINX_PORT=${port} 已被其他进程监听；启动时可能发生端口冲突`;
}
