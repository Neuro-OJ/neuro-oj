/** `check` / `verify` 命令：配置校验与镜像签名验证（自 `prod/cli.ts` 拆出）。 */

import { prodDeps } from "./deps.ts";
import type { ProdCliDeps, ProdCliResult } from "./types.ts";

/** `check`：配置与依赖校验（复用 `lifecycle/steps.ts:prepareAndCheck` 六步）。 */
export async function runProdCheck(
  dir: string,
  _args: string[],
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
  return { exitCode: 0, message: "生产配置检查通过" };
}

/**
 * `verify`：配置校验 **+ 镜像签名验证**（bash `deploy.sh:911` 的
 * `install|start|upgrade|verify) verify_image_signatures`）。
 *
 * ## 为什么必须有这个函数（评审发现）
 *
 * 此前 `dispatchProduction` 的 `case "verify"` 直接调 `runProdCheck`——
 * 与 `check`/`config` **完全相同**，而注释与 help 都写着"比 check 多验签名"。
 * 也就是说：**一个安全控制报成功但从未运行**，而运维者会把它当作部署前的
 * 保证闸门。比"没有该命令"更糟——后者至少不会被误信。
 * bash 是真跑的，`verifyImageSignatures` 也早已实现并在 install/update 里使用，
 * 只是 `verify` 命令的接线漏了。
 */
export async function runProdVerify(
  dir: string,
  _args: string[],
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
