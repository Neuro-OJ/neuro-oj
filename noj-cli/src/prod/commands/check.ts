/** `check` / `verify` 命令：配置校验、磁盘余量展示与镜像签名验证。 */

import { formatDiskReportLines, probeDiskUsageReport } from "../disk-space.ts";
import { hasJson } from "./args.ts";
import { prodDeps } from "./deps.ts";
import type { ProdCliDeps, ProdCliResult } from "./types.ts";

async function emitDiskCheckSummary(
    dir: string,
    args: string[],
    d: ReturnType<typeof prodDeps>,
    deps: ProdCliDeps,
): Promise<void> {
    const report = await probeDiskUsageReport({
        runner: d.runner,
        installDir: dir,
        dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"],
    });
    if (report === null) return;
    const sink = hasJson(args)
        ? (deps.err ?? ((t: string) => console.error(t)))
        : (deps.out ?? ((t: string) => d.io.write(t + "\n")));
    for (const line of formatDiskReportLines(report)) {
        sink(line);
    }
}

/** `check`：配置与依赖校验（复用 `lifecycle/steps.ts:prepareAndCheck` 六步）并展示磁盘余量。 */
export async function runProdCheck(
    dir: string,
    args: string[],
    deps: ProdCliDeps,
): Promise<ProdCliResult> {
    const d = prodDeps(deps);
    const { prepareAndCheck } = await import("../lifecycle/steps.ts");
    const prepared = await prepareAndCheck({
        dir,
        runner: d.runner,
        write: (text) => d.io.write(text + "\n"),
    });
    if (!prepared.ok) return { exitCode: 1, message: prepared.error };
    await emitDiskCheckSummary(dir, args, d, deps);
    return { exitCode: 0, message: "生产配置检查通过" };
}

/**
 * `verify`：配置校验 **+ 磁盘余量展示 + 镜像签名验证**。
 *
 * ## 为什么必须有这个函数
 *
 * 此前 `dispatchProduction` 的 `case "verify"` 直接调 `runProdCheck`——
 * 与 `check`/`config` **完全相同**，而注释与 help 都写着"比 check 多验签名"。
 * 也就是说：**一个安全控制报成功但从未运行**，而运维者会把它当作部署前的
 * 保证闸门。比"没有该命令"更糟——后者至少不会被误信。
 * `verifyImageSignatures` 早已在 install/update 里使用，只是 `verify` 的接线漏了。
 */
export async function runProdVerify(
    dir: string,
    args: string[],
    deps: ProdCliDeps,
): Promise<ProdCliResult> {
    const d = prodDeps(deps);
    const { prepareAndCheck } = await import("../lifecycle/steps.ts");
    const prepared = await prepareAndCheck({
        dir,
        runner: d.runner,
        write: (text) => d.io.write(text + "\n"),
    });
    if (!prepared.ok) return { exitCode: 1, message: prepared.error };
    await emitDiskCheckSummary(dir, args, d, deps);

    const { probeCosign } = await import("../lifecycle.ts");
    const { verifyImageSignatures } = await import("../config.ts");
    const { env } = prepared;
    const result = await verifyImageSignatures(env, {
        runner: d.runner,
        cosignAvailable: probeCosign(
            d.runner,
            d.processEnv["NOJ_COSIGN_BIN"] ?? "cosign",
        ),
        dockerBin: d.processEnv["NOJ_DEPLOY_DOCKER_BIN"] ?? "docker",
        cosignBin: d.processEnv["NOJ_COSIGN_BIN"] ?? "cosign",
        warn: (m) => (deps.err ?? ((t: string) => console.error(t)))(m),
    });
    if (!result.ok) {
        return {
            exitCode: 1,
            message: result.error ?? "生产镜像签名校验失败",
        };
    }
    return {
        exitCode: 0,
        message: result.skipped === true
            ? "生产配置检查通过（镜像签名校验已按配置跳过）"
            : `生产配置检查通过（已校验 ${result.digests.length} 个镜像签名）`,
    };
}
