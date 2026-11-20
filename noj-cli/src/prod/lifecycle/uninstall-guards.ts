/**
 * uninstall 的前置检查与安装目录守卫。
 *
 * 1. uninstall 前置：docker CLI / daemon / compose v2 / `.env.prod` /
 *    compose 文件五条，**任一缺失即拒绝**；
 * 2. `--all` 直接 `rm -rf` 安装目录前的守卫
 *    （目录形态 → 安装完整性 → **Git 工作区拒绝** → 危险路径拒绝）。
 *
 * 为什么独立成模块：两者与 `prepareAndCheck` 同类——都是「命令变更任何东西
 * 之前必须通过」的判定，且被 `uninstall` 与（后续）`update` 复用。
 */

import { join } from "@std/path";
import { PRODUCTION_MARKERS } from "../install-dir.ts";
import { type CommandRunner } from "../../runtime/command.ts";
import { PROD_COMPOSE_FILE, PROD_ENV_FILE } from "../compose.ts";
import { isFile, pathExists } from "../../util/fs.ts";
import { type PrepareFailure } from "./steps.ts";

/** docker CLI 缺失文案。 */
export function dockerMissingHint(dockerBin: string): string {
  return `找不到 Docker CLI：${dockerBin}`;
}

/** daemon 不可用文案。 */
export const UNINSTALL_DAEMON_HINT = "Docker daemon 未运行或当前用户无权限";

/** Compose v2 不可用文案。 */
export const UNINSTALL_COMPOSE_HINT = "Docker Compose v2 不可用";

/** `.env.prod` 缺失文案。 */
export function uninstallEnvMissingHint(envFile: string): string {
  return `找不到生产配置：${envFile}；无法安全定位生产 Compose 栈`;
}

/** compose 文件缺失文案。 */
export function uninstallComposeMissingHint(composeFile: string): string {
  return `找不到生产 Compose 文件：${composeFile}`;
}

/** 工作区拒绝文案。 */
export const UNINSTALL_WORKSPACE_HINT =
  "检测到 Git 工作区，拒绝删除源码目录；请在生产安装目录执行 uninstall --all";

/** 危险路径拒绝文案。 */
export function uninstallUnsafePathHint(dir: string): string {
  return `拒绝删除危险安装路径：${dir}`;
}

/** 安装目录形态不符文案。 */
export function uninstallNotADirHint(dir: string): string {
  return `当前安装目录不存在或不是普通目录：${dir}`;
}

/** 安装目录不完整文案。 */
export function uninstallIncompleteDirHint(dir: string): string {
  return `当前目录不是完整的 NOJ 安装目录，拒绝完全删除：${dir}`;
}

/**
 * 执行"存在性探测"命令并归一到退出码：**命令无法启动时返回 `null`**。
 *
 * 真实 {@link CommandRunner}（`runtime/command.ts`）用 `Deno.Command`：二进制
 * 不在 PATH 时 `output()` **抛 `Deno.errors.NotFound`**，而不是返回非 0。
 * 存在性探测需要把"找不到"归一成一个失败信号；若直接取 `(await runner.run(...)).code`，
 * 真实主机上缺 docker/cosign 会把可操作文案换成裸异常。
 *
 * @returns 退出码；命令无法启动（不存在/无权限）时为 `null`。
 */
export async function probeCommandCode(
  runner: CommandRunner,
  cmd: string,
  args: string[],
): Promise<number | null> {
  try {
    return (await runner.run(cmd, args)).code;
  } catch {
    return null;
  }
}

/** {@link checkUninstallDependencies} 的成功分支：卸载所需的三个已定位路径。 */
export interface UninstallDependencies {
  ok: true;
  /** 归一化安装目录（无尾斜杠）。 */
  dir: string;
  envFile: string;
  composeFile: string;
}

/** {@link checkUninstallDependencies} 的结果。 */
export type UninstallDependenciesResult =
  | UninstallDependencies
  | PrepareFailure;

/**
 * `check_uninstall_dependencies`：卸载前的五条前置。
 *
 * 逐条顺序：`docker --version` → `docker info` → `docker compose version` →
 * `.env.prod` 存在 → compose 文件存在；**任一失败立即返回错误**，由调用方转成
 * 退出码 1 且**零 compose down**。三条 docker 探测都经 {@link probeCommandCode}：
 * spawn 失败（二进制缺失）与退出码非 0 同样落在"失败"分支。
 *
 * **只判定存在性，不解析 `.env.prod`**：卸载恒带 judge profile（见
 * `uninstall()` 的注释），不需要 `judge` 旗标，成功分支只回填三个路径字段。
 */
export async function checkUninstallDependencies(opts: {
  dir: string;
  runner: CommandRunner;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
}): Promise<UninstallDependenciesResult> {
  const dockerBin = opts.dockerBin ?? "docker";
  const envFile = join(opts.dir, PROD_ENV_FILE);
  const composeFile = join(opts.dir, PROD_COMPOSE_FILE);

  if (
    (await probeCommandCode(opts.runner, dockerBin, ["--version"])) !== 0
  ) {
    return { ok: false, error: dockerMissingHint(dockerBin) };
  }
  if ((await probeCommandCode(opts.runner, dockerBin, ["info"])) !== 0) {
    return { ok: false, error: UNINSTALL_DAEMON_HINT };
  }
  if (
    (await probeCommandCode(opts.runner, dockerBin, ["compose", "version"])) !==
      0
  ) {
    return { ok: false, error: UNINSTALL_COMPOSE_HINT };
  }
  if (!(await isFile(envFile))) {
    return { ok: false, error: uninstallEnvMissingHint(envFile) };
  }
  if (!(await isFile(composeFile))) {
    return { ok: false, error: uninstallComposeMissingHint(composeFile) };
  }

  return { ok: true, dir: opts.dir, envFile, composeFile };
}

/**
 * `--all` 的安装目录守卫，四条检查：
 *
 * 1. 是普通目录且不是符号链接；
 * 2. **安装完整性**：`bin/noj-cli` 存在（可执行）**且** {@link PRODUCTION_MARKERS}
 *    两个特征文件存在；各缺失分支共用 {@link uninstallIncompleteDirHint}；
 * 3. 目录含 `.git` 或 `.jj`（像源码工作区）→ 拒绝；
 * 4. 不是 `/`、`.`、`..` 或 `$HOME`。
 *
 * **抛错而非返回结果**：守卫失败必须终止整个命令，返回布尔容易被调用方误当成
 * 可继续的信号。
 */
export async function assertRemovableInstallDir(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    /** 安装版 CLI 路径；缺省 `<dir>/bin/noj-cli`。 */
    cliBinary?: string;
  } = {},
): Promise<void> {
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.lstat(dir);
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory || st.isSymlink) {
    throw new Error(uninstallNotADirHint(dir));
  }

  const cliBinary = opts.cliBinary ?? join(dir, "bin/noj-cli");
  // 各条 `-f` 用 `&&` 串在一起时失败只有**一句**文案，
  // 无法（也不应）区分是哪一个特征文件缺失。
  if (!(await isFile(cliBinary))) {
    throw new Error(uninstallIncompleteDirHint(dir));
  }
  for (const marker of PRODUCTION_MARKERS) {
    if (!(await isFile(join(dir, marker)))) {
      throw new Error(uninstallIncompleteDirHint(dir));
    }
  }

  if (
    await pathExists(join(dir, ".git")) || await pathExists(join(dir, ".jj"))
  ) {
    throw new Error(UNINSTALL_WORKSPACE_HINT);
  }

  const normalized = dir.replace(/\/+$/, "");
  const home = (processEnv["HOME"] ?? "").replace(/\/+$/, "");
  if (
    normalized === "" || normalized === "/" || normalized === "." ||
    normalized === ".." || (home !== "" && normalized === home)
  ) {
    throw new Error(uninstallUnsafePathHint(dir));
  }
}

/**
 * 删除安装目录：先守卫、再 `rm -rf`；删除失败即抛错。
 */
export async function removeInstallDirectory(
  dir: string,
  processEnv: Record<string, string | undefined> = Deno.env.toObject(),
  opts: {
    cliBinary?: string;
  } = {},
): Promise<void> {
  await assertRemovableInstallDir(dir, processEnv, opts);
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    throw new Error(`无法删除 NOJ 安装目录：${dir}`);
  }
}
