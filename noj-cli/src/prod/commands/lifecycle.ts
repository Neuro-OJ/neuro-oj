/** 生命周期命令：`install` / `status` / `start` / `stop` / `restart` / `logs` / `uninstall`。 */

import {
  DEFAULT_UPDATE_REPOSITORY,
  resolveLatestReleaseTag,
} from "../release.ts";
import {
  install,
  type InstallResult,
  logs,
  type LogsResult,
  restart,
  start,
  status,
  type StatusResult,
  stop,
  uninstall,
  type UninstallResult,
} from "../lifecycle.ts";
import type { LifecycleBaseResult } from "../lifecycle.ts";
import { DEFAULT_REPOSITORY } from "../install-defaults.ts";
import { flagValue, hasFlag, positionals } from "./args.ts";
import { prodDeps, renderIOOf } from "./deps.ts";
import type { ProdCliDeps, ProdCliResult } from "./types.ts";

/** `install`：唯一生产安装路径（T12）。 */
export async function runProdInstall(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<ProdCliResult> {
  const d = prodDeps(deps);
  const result: InstallResult = await install({
    dir,
    repository: flagValue(args, "--repo") ?? DEFAULT_REPOSITORY,
    // **缺省不再是分支名 `main`**（评审发现的 R4 阻塞）：
    // 删掉的 `install.sh:722` 在无 `--ref` 时调 `resolve_latest_ref`——
    // 查询 Release 列表并选**最新的资产就绪正式版**（已转正的 `-rc.N` 等标签同样可选）。这与 R4 的前提一致：
    // 用户手动下载的是某个**标签**的二进制，`install` 必须从**同一个**标签取
    // 部署文件，否则会出现 issue #431 要避免的"CLI 与部署文件版本不一致"。
    //
    // 修前实测：`install --dir X`（无 --ref）只尝试
    // `https://github.com/.../releases/download/main/docker-compose.prod.yml` → 404，
    // 而文档正是让用户这么装（`install --dir /opt/neuro-oj`，无 --ref）。
    ref: flagValue(args, "--ref") ?? flagValue(args, "--version") ??
      d.processEnv["NOJ_DEPLOY_DEFAULT_VERSION"] ??
      // 用**宽资产集**解析器（CLI + compose + example 及其校验文件）：
      // install 恰好要用到全部这些资产，只按 CLI 资产过滤会选中一个
      // "有二进制但没有部署文件"的 Release，随后同步必然失败（issue #431）。
      await resolveLatestReleaseTag({
        repository: flagValue(args, "--repo") ?? DEFAULT_REPOSITORY,
        apiUrl: d.processEnv["NOJ_UPDATE_API_URL"],
        fetcher: deps.fetcher,
      }),
    io: d.io,
    runner: d.runner,
    fetcher: deps.fetcher,
    isTty: d.isTty(),
    nonInteractive: hasFlag(args, "--non-interactive"),
    passphraseFile: flagValue(args, "--passphrase-file"),
    processEnv: d.processEnv,
    now: deps.now?.(),
  });
  return { exitCode: 0, message: `生产部署完成（${result.dir}）` };
}

/** `status`（T13：含 T4 状态机）。 */
export function runProdStatus(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<StatusResult> {
  return status({
    dir,
    runner: prodDeps(deps).runner,
    args,
    io: renderIOOf(deps),
  });
}

/** `start` / `stop` / `restart`（T13：含 no-op 判定）。 */
export function runProdStart(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return start({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `stop`。 */
export function runProdStop(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return stop({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `restart`。 */
export function runProdRestart(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LifecycleBaseResult> {
  const d = prodDeps(deps);
  return restart({ dir, runner: d.runner, args, io: renderIOOf(deps) });
}

/** `logs`（T14：着色契约 + `--follow` 走 stream）。 */
export function runProdLogs(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<LogsResult> {
  const d = prodDeps(deps);
  return logs({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    services: positionals(args),
    follow: hasFlag(args, "--follow", "-f"),
    env: d.processEnv,
  });
}

/** `uninstall`（T15：确认词 + 数据卷安全 + 工作区保护）。 */
export function runProdUninstall(
  dir: string,
  args: string[],
  deps: ProdCliDeps,
): Promise<UninstallResult> {
  const d = prodDeps(deps);
  const tty = d.isTty();
  return uninstall({
    dir,
    runner: d.runner,
    args,
    io: renderIOOf(deps),
    yes: hasFlag(args, "--yes", "-y"),
    all: hasFlag(args, "--all"),
    isTty: tty,
    processEnv: d.processEnv,
    // T15 carry-forward：确认读取缺省不读真实 stdin（绝不放行破坏性操作）。
    // 这里由 CLI 层接上真实 PromptIO——**仅在有 TTY 时**（无 TTY 时 uninstall
    // 自己会硬错误，接上读取器反而会掩盖那条可操作提示）。
    readConfirm: tty ? (prompt: string) => d.io.readLine(prompt) : undefined,
  });
}

export { DEFAULT_UPDATE_REPOSITORY };
