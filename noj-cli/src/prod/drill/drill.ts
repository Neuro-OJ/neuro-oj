/**
 * 隔离恢复演练的编排。
 *
 * ## 本模块**零** shell / 脚本调用
 *
 * - 恢复序列全部经注入的 `CommandRunner` 发 `docker compose …`；
 * - 业务验收由 CLI 直接发 HTTP（见 `verify.ts`），经容器 IP 访问隔离网络。
 *
 * ## 退出码语义（#516 验收，三条都不变）
 *
 * | 码 | 含义 | 判定时机 |
 * | --- | --- | --- |
 * | 0 | 演练通过且 RPO/RTO 达标 | 全部步骤成功 |
 * | 1 | 演练失败（含 RPO/RTO 超限、业务验收失败、数据核对不符） | 恢复/核对/验收 |
 * | 2 | 参数或资源错误 | **起任何容器之前** |
 *
 * ## 失败也清理（#516 验收）
 *
 * 无论从哪个阶段退出，只要已经起了资源，就必须 `compose down -v --remove-orphans`
 * 并删演练目录（`--keep` 才保留）。**清理自身失败不掩盖原始错误**：原始失败原因
 * 是诊断的核心，清理失败只作为附加信息追加。
 *
 * ## 二进制与转储的搬运
 *
 * `postgres.dump` / `redis.rdb` 一律经**文件重定向**（`driver.ts` 的
 * `feedFromFile`/`captureToFile` 语义），不经 stdout 字符串——理由见该模块头。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2）：状态全在一次运行对象里。
 */

import { join } from "@std/path";
import { type CommandRunner } from "../../runtime/command.ts";
import {
    type ContainerPayloadOps,
    unpackContainer,
} from "../backup/container.ts";
import { UsageError } from "../../util/args.ts";
import {
    allocateDrillDir,
    assertDedicatedDockerHost,
    assertDrillProjectName,
    assertSubnetCidr,
    checkDrillPreflight,
    checkPassphraseFile,
    DEFAULT_RPO_MAX_HOURS,
    DEFAULT_RTO_MAX_MINUTES,
    DEFAULT_WAIT_TIMEOUT,
    probeDocker,
    probeFreeBytes,
    renderDrillOverride,
    resolveReportPath,
    uniqueDrillProjectName,
    uniqueDrillSubnet,
} from "./plan.ts";
import { renderSeedDrillAdminSql } from "./seed-admin-sql.ts";
import {
    type ChecksInput,
    formatHours,
    hoursSinceSnapshot,
    snapshotCreatedAt,
} from "./report.ts";
import { resolveCoreBaseUrl } from "./network.ts";
import { withDockerHost } from "./runtime.ts";
import { runBusinessVerification } from "./verify.ts";
import { readEnvValuesOrEmpty } from "../../core/env-file.ts";
import {
    dockerBinOf,
    type DrillContext,
    drillTarget,
    restoreDataServices,
    runDrillSql,
    startBusinessServices,
    verifyData,
} from "./stack.ts";
import {
    cleanupStaging,
    downDrillStack,
    failAndCleanup,
    readTextOr,
    writeMetrics,
    writeReport,
} from "./finish.ts";

/** {@link runDrill} 的注入点：一切外部访问都可替换。 */
export interface DrillRunOptions {
    /** 快照路径（`.nojbackup` 单文件）。 */
    snapshotPath: string;
    /** 生产安装目录。 */
    dir: string;
    /** 命令注入点（docker）。 */
    runner: CommandRunner;
    /** 解包与加密操作（缺省由 runner 构造真实 driver）。 */
    ops?: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
    /** 口令文件。 */
    passphraseFile?: string;
    /** 演练项目名（缺省每次唯一生成；测试可显式指定）。 */
    projectName?: string;
    /** 演练子网（缺省每次唯一生成；测试可显式指定）。 */
    subnet?: string;
    /** 演练目录（缺省快照同级的 `drill-<ts>`）。 */
    drillDir?: string;
    /** 报告路径（缺省快照同级的 `restore-drill-report.txt`）。 */
    report?: string;
    /** RPO 上限（小时，缺省 24）。 */
    rpoMaxHours?: number;
    /** RTO 上限（分钟，缺省 60）。 */
    rtoMaxMinutes?: number;
    /** Compose 等待超时（秒，缺省 300）。 */
    waitTimeout?: number;
    /** 跳过 judge 相关验收。 */
    skipJudge?: boolean;
    /** 保留演练资源与目录（供人工检查）。 */
    keep?: boolean;
    /** 人类日志汇聚点。 */
    log?: (line: string) => void;
    /** HTTP 客户端（业务验收用；缺省全局 fetch）。 */
    fetch?: typeof fetch;
    /** 时间源（测试注入）。 */
    now?: () => Date;
    /** 睡眠（测试注入以避免真实等待）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 指标目录（缺省快照同级 `metrics/`）。 */
    metricsDir?: string;
    /** judge 镜像白名单的注入点（缺省用 runner 查隔离库）。 */
    resolveJudgeImages?: (ctx: JudgeImageContext) => Promise<{
        evaluator: string;
        solution: string;
    }>;
    /** docker 可执行名（`NOJ_BACKUP_DOCKER_BIN`）。 */
    dockerBin?: string;
    /** 专用隔离 Docker daemon 的 Unix socket（生产演练必填）。 */
    dockerHost?: string;
    /**
     * 快照是否加密（缺省 `true`，对应 `backup create` 的默认行为）。
     *
     * `backup create --no-encrypt` 的产物必须也能演练：
     * 此前 drill 无条件按加密解包，不加密的快照会在 `gpg --decrypt` 处失败，
     * 于是"不加密"这条受支持的路径无法做恢复验收。
     */
    encrypted?: boolean;
}

/** 查评测镜像白名单的上下文。 */
export interface JudgeImageContext {
    projectName: string;
    composeEnvFile: string;
    composeFile: string;
    overrideFile: string;
}

/** 演练结果。 */
export interface DrillRunResult {
    /** 是否通过（含 RPO/RTO 达标）。 */
    pass: boolean;
    /** 0 通过 / 1 演练失败 / 2 参数或资源错误。 */
    exitCode: number;
    /** 报告路径；前置阶段失败时为 null（此时未写报告）。 */
    reportPath: string | null;
    /** 面向用户的一句话结论。 */
    message: string;
    /** 失败的阶段名（成功时 null）。 */
    failedStage: string | null;
    /** 数据核对明细（成功时非 null）。 */
    checks: ChecksInput | null;
}

/**
 * 执行隔离恢复演练。
 *
 * 流程（阶段名用于失败报告定位）：
 * `preflight`（参数/资源/快照校验，**零 compose 调用**）→ `prepare`（目录、解密 env、
 * 覆盖文件）→ `restore-data` → `verify-data` → `seed-admin` → `start-business`
 * → `business-verify` → `report`。
 *
 * **前置失败返回 2 且不写报告**；其余失败写失败
 * 报告、清理资源、返回 1。
 */
export async function runDrill(
    opts: DrillRunOptions,
): Promise<DrillRunResult> {
    const log = opts.log ?? (() => {});
    const now = opts.now ?? (() => new Date());
    const dockerBin = opts.dockerBin ?? "docker";
    const projectName = opts.projectName ?? uniqueDrillProjectName(now());
    const subnet = opts.subnet ?? uniqueDrillSubnet();
    const rpoMaxHours = opts.rpoMaxHours ?? DEFAULT_RPO_MAX_HOURS;
    const rtoMaxMinutes = opts.rtoMaxMinutes ?? DEFAULT_RTO_MAX_MINUTES;
    const waitTimeout = opts.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
    const judge = opts.skipJudge !== true;
    const keep = opts.keep === true;
    const dockerHost = opts.dockerHost;

    // ---- 参数校验：**最先**（纯参数错误不应被资源错误掩盖）----
    try {
        assertDrillProjectName(projectName);
        if (opts.subnet !== undefined) assertSubnetCidr(subnet);
        assertNonNegativeInt("RPO", rpoMaxHours);
        assertNonNegativeInt("RTO", rtoMaxMinutes);
        // 口令**始终必需**：`--no-encrypt` 只关闭整包那一层，`env.prod.gpg`
        // 这一层恒为加密（见 `createContainer` 第 5 步与 `container.ts` 的
        // `CONTAINER_FILES.envProdGpg`），演练要解出 `.env.prod` 就必须有口令。
        if (opts.passphraseFile === undefined || opts.passphraseFile === "") {
            throw new UsageError(
                "必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE",
            );
        }
        if (dockerHost === undefined || dockerHost.trim() === "") {
            throw new UsageError(
                "必须提供 --docker-host 或 NOJ_DRILL_DOCKER_HOST（专用隔离 Docker daemon）",
            );
        }
        assertDedicatedDockerHost(dockerHost);
    } catch (err) {
        return preflightFailure(err);
    }

    // Docker CLI、Compose 以及 docker inspect 必须共享同一专用 daemon。
    // 强制覆盖调用方遗留的 DOCKER_HOST，避免某一步意外回到宿主机 daemon。
    const runner = withDockerHost(opts.runner, dockerHost);

    // ---- 解包快照（在资源检查之前：损坏的快照不该先起容器）----
    let staged: { staging: string; tempRoot: string };
    try {
        staged = await unpackForDrill(opts, projectName, now);
    } catch (err) {
        return preflightFailure(err);
    }

    const ctx: DrillContext = {
        projectName,
        subnet,
        dir: opts.dir,
        snapshot: opts.snapshotPath,
        staging: staged.staging,
        drillDir: staged.tempRoot,
        tempDir: join(staged.tempRoot, ".work"),
        composeFile: join(opts.dir, "docker-compose.prod.yml"),
        composeEnvFile: join(staged.tempRoot, ".work/env.drill"),
        overrideFile: join(staged.tempRoot, ".work/compose.drill-override.yml"),
        reportPath: resolveReportPath(opts.snapshotPath, opts.report),
        env: {},
        judge,
    };
    const reportPath = ctx.reportPath;

    try {
        // ---- preflight（资源 + 口令 + 环境文件；全部在起容器之前）----
        await checkPassphraseFile(opts.passphraseFile!);
        ctx.env = await readEnvValuesOrEmpty(join(opts.dir, ".env.prod"));
        await checkDrillPreflight({
            staging: ctx.staging,
            dir: opts.dir,
            envFile: join(opts.dir, ".env.prod"),
            composeFile: ctx.composeFile,
            projectName,
            dockerAvailable: probeDocker(runner, dockerBin),
            freeBytes: probeFreeBytes(runner, staged.tempRoot),
        });
    } catch (err) {
        await cleanupStaging(staged.tempRoot, keep);
        return preflightFailure(err);
    }

    // ---- prepare：写入覆盖文件与解密后的 env ----
    const startedAt = now().toISOString();
    try {
        await prepareDrillEnvironment(opts, ctx, runner);
    } catch (err) {
        const message = (err as Error).message;
        return await failAndCleanup(
            opts,
            ctx,
            runner,
            keep,
            "prepare",
            message,
            startedAt,
            log,
        );
    }

    const totalStart = now().getTime();
    let restoreSeconds = 0;
    let checks: ChecksInput | null = null;
    const verifyLines: string[] = [];

    try {
        // ---- restore-data ----
        const restoreStart = now().getTime();
        await restoreDataServices(ctx, runner, dockerBin, waitTimeout, log);
        // ---- verify-data ----
        checks = await verifyData(ctx, runner, dockerBin, log);
        restoreSeconds = Math.round((now().getTime() - restoreStart) / 1000);

        // ---- seed-admin + start-business ----
        await runDrillSql(
            ctx,
            runner,
            dockerBin,
            renderSeedDrillAdminSql(
                now().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
            ),
            "写入演练管理员失败",
        );
        const judgeImages = await startBusinessServices(
            ctx,
            runner,
            dockerBin,
            waitTimeout,
            opts,
            log,
        );

        // ---- business-verify（原生 HTTP，经容器 IP）----
        const coreUrl = await resolveCoreBaseUrl(ctx, runner, dockerBin);
        const verify = await runBusinessVerification({
            baseUrl: coreUrl,
            fetch: opts.fetch ?? fetch,
            evaluatorImage: judgeImages.evaluator,
            solutionImage: judgeImages.solution,
            skipEvaluation: !judge,
            sleep: opts.sleep,
            now: opts.now === undefined
                ? undefined
                : () => opts.now!().getTime(),
            log: (line) => {
                verifyLines.push(line);
                log(line);
            },
        });
        if (!verify.passed) {
            throw new Error(
                `业务验收未通过：${verify.firstFailure ?? "未知原因"}`,
            );
        }
    } catch (err) {
        const message = (err as Error).message;
        return await failAndCleanup(
            opts,
            ctx,
            runner,
            keep,
            "business-verify",
            message,
            startedAt,
            log,
            verifyLines.join("\n"),
        );
    }

    // ---- report：RPO/RTO 硬阈值 ----
    const totalSeconds = Math.round((now().getTime() - totalStart) / 1000);
    const rtoMinutes = Math.floor(totalSeconds / 60);
    const createdAt = snapshotCreatedAt(
        await readTextOr(join(ctx.staging, "manifest.json"), ""),
    );
    const rpoHours = hoursSinceSnapshot(createdAt, now());
    const rpoMet = rpoHours <= rpoMaxHours;
    const rtoMet = rtoMinutes <= rtoMaxMinutes;
    const result: "passed" | "passed_with_warnings" = rpoMet && rtoMet
        ? "passed"
        : "passed_with_warnings";

    await writeReport(ctx, {
        result,
        snapshotCreatedAt: createdAt,
        drillStartedAt: startedAt,
        drillFinishedAt: now().toISOString(),
        restoreDurationSeconds: restoreSeconds,
        totalDurationSeconds: totalSeconds,
        rpoHours: formatHours(rpoHours),
        rpoTargetHours: rpoMaxHours,
        rpoMet,
        rtoMinutes,
        rtoTargetMinutes: rtoMaxMinutes,
        rtoMet,
        verifyLog: verifyLines.join("\n"),
        cleanup: keep ? "kept-for-review" : "done",
    }, checks!);

    // ---- 清理（成功路径；失败路径由 failAndCleanup 负责）----
    if (!keep) {
        await downDrillStack(ctx, runner, dockerBin);
        await Deno.remove(ctx.drillDir, { recursive: true });
    }

    // 指标**只在成功且 RPO/RTO 达标时**写：告警语义是"最近一次成功距今多久"，
    // 让"跑完但超标"也刷新时间戳会掩盖演练失效这件事。
    if (rpoMet && rtoMet) {
        await writeMetrics(opts, ctx, now());
    } else {
        log(
            `! RPO/RTO 未达标（RPO ${
                formatHours(rpoHours)
            }h / 目标 ${rpoMaxHours}h；` +
                `RTO ${rtoMinutes}min / 目标 ${rtoMaxMinutes}min），已按演练失败处理且不刷新指标`,
        );
    }

    const pass = rpoMet && rtoMet;
    return {
        pass,
        exitCode: pass ? 0 : 1,
        reportPath,
        failedStage: pass ? null : "rpo-rto",
        checks,
        message: pass
            ? "恢复演练通过：隔离环境成功恢复并通过业务验收"
            : "恢复演练失败：RPO/RTO 未达标（详见报告）——演练要求硬阈值达标",
    };
}

/** 前置失败（退出码 2，**零 compose 调用**、不写报告）。 */
function preflightFailure(err: unknown): DrillRunResult {
    return {
        pass: false,
        exitCode: 2,
        reportPath: null,
        failedStage: "preflight",
        checks: null,
        message: (err as Error).message,
    };
}

/** 非负整数校验。 */
function assertNonNegativeInt(label: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new UsageError(`${label} 目标必须是非负整数，收到 "${value}"`);
    }
}

/** 解包快照到演练目录（只接受 `.nojbackup` 单文件）。 */
async function unpackForDrill(
    opts: DrillRunOptions,
    projectName: string,
    now: () => Date,
): Promise<{ staging: string; tempRoot: string }> {
    if (!opts.snapshotPath.endsWith(".nojbackup")) {
        throw new UsageError(
            `drill 只接受 .nojbackup 单文件快照：${opts.snapshotPath}\n` +
                "  原因：单文件容器是唯一形态（payload_layout=prod-raw），" +
                "目录形态的旧快照已不受支持。",
        );
    }
    const drillDir = await allocateDrillDir(
        opts.snapshotPath,
        now(),
        opts.drillDir,
    );
    await Deno.mkdir(join(drillDir, ".work"), { recursive: true, mode: 0o700 });
    await Deno.chmod(drillDir, 0o700);

    // gpg 从**文件参数**读输入（不是 stdin），故走 run；tar 同理。
    // 只有二进制 payload 的采集/回灌才需要文件重定向（见 backup/driver.ts）。
    const ops = opts.ops ?? {
        async gpgDecrypt(src, dest, passphraseFile) {
            const res = await opts.runner.run("gpg", [
                "--batch",
                "--yes",
                "--pinentry-mode",
                "loopback",
                "--passphrase-file",
                passphraseFile,
                "--decrypt",
                "--output",
                dest,
                src,
            ]);
            if (res.code !== 0) throw new Error("gpg 解密失败");
        },
        async untarZst(src, destDir) {
            await Deno.mkdir(destDir, { recursive: true });
            const res = await opts.runner.run("tar", [
                "-I",
                "zstd",
                "-xf",
                src,
                "-C",
                destDir,
            ]);
            if (res.code !== 0) {
                throw new Error(`tar 解包失败：${res.stderr.trim()}`);
            }
        },
    };

    const unpacked = await unpackContainer({
        path: opts.snapshotPath,
        destDir: join(drillDir, ".work/unpack"),
        passphraseFile: opts.passphraseFile,
        encrypted: opts.encrypted,
        ops,
    });

    // payload_layout 是唯一形态契约：非 prod-raw 一律拒绝（无分派）。
    if (unpacked.manifest?.payload_layout !== "prod-raw") {
        throw new UsageError(
            `快照 payload_layout 不受支持：${
                unpacked.manifest?.payload_layout ?? "(缺失)"
            }（只支持 prod-raw）`,
        );
    }
    void projectName;
    return { staging: unpacked.staging, tempRoot: drillDir };
}

/** 写覆盖文件与解密后的 env。 */
async function prepareDrillEnvironment(
    opts: DrillRunOptions,
    ctx: DrillContext,
    runner: CommandRunner,
): Promise<void> {
    // 解密 env.prod.gpg 到演练 env，并叠加隔离配置（评测器网络名指向演练网络）。
    // 注意 `env.prod.gpg` 这一层**恒为加密**：`create --no-encrypt` 只关闭整包
    // 那一层（见 `createContainer` 第 5 步），故这里无需按 encrypted 分流。
    const envSrc = join(ctx.staging, "env.prod.gpg");
    {
        const code = await runner.run("gpg", [
            "--batch",
            "--yes",
            "--pinentry-mode",
            "loopback",
            "--passphrase-file",
            opts.passphraseFile!,
            "--decrypt",
            "--output",
            ctx.composeEnvFile,
            envSrc,
        ]);
        if (code.code !== 0) throw new Error("解密快照内的环境文件失败");
    }
    const size = (await Deno.stat(ctx.composeEnvFile)).size;
    if (size === 0) throw new Error("解密后的环境文件为空");
    await Deno.chmod(ctx.composeEnvFile, 0o600);
    await Deno.writeTextFile(
        ctx.composeEnvFile,
        `\n# ---- restore-drill 隔离覆盖（自动生成，勿提交） ----\n` +
            // 演练 stack 使用**自己的**评测隔离网络（审计 VULN-20）：生产网络的
            // `noj-eval-net` 是固定名（name: 常量），若演练沿用同名会与生产网络冲突
            // （Compose 复用/重建会打在有活动端点的生产网络上）。两个变量必须同值：
            // 前者是 compose 声明的网络名，后者是 judge 接入 Evaluator 容器时用的名字。
            `NOJ_EVAL_NETWORK_NAME=${ctx.projectName}_noj-eval-net\n` +
            `JUDGE_EVALUATOR_NETWORK=${ctx.projectName}_noj-eval-net\n`,
        { append: true },
    );

    await Deno.writeTextFile(ctx.overrideFile, renderDrillOverride(ctx.subnet));
    // 只读解析校验（`compose config --quiet`）
    const dockerBin = dockerBinOf(opts);
    const check = await runner.run(
        dockerBin,
        drillTarget(ctx, runner, dockerBin).composeArgs(["config", "--quiet"]),
    );
    if (check.code !== 0) {
        throw new Error("演练 Compose 配置无效：" + check.stderr.trim());
    }
}
