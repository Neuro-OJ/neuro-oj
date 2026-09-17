/**
 * Tier 3 容器命令的执行器（#518 P5）。
 *
 * 与 `container.ts`（纯构造/渲染）分离：本文件触碰进程与文件系统，
 * 便于纯逻辑保持可单测。
 */
import { buildComposeArgs, productionPaths } from "./container.ts";

/** 执行选项。 */
export interface RunContainerOptions {
  /** 生产安装目录。 */
  dir: string;
  service: string;
  /** 容器内 CLI 的子命令与参数。 */
  command: string[];
  /** 仅打印将执行的命令，不实际执行。 */
  dryRun?: boolean;
  /** 输出渲染后的命令（默认 console.log）。 */
  log?: (line: string) => void;
}

/**
 * 以容器方式执行 Tier 3 命令，**原样透传退出码**。
 *
 * `stdin: "inherit"` 是硬要求：`admin bootstrap first-admin` 需隐藏输入密码，
 * 必须让子进程直接接管终端（与 `runProduction` 的既有模式一致）。
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
  });

  if (options.dryRun) {
    const log = options.log ?? console.log;
    log(`dry-run: docker ${renderForLog(args)}`);
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

/** 复用 `container.ts` 的安全引用规则渲染，避免两处实现漂移。 */
function renderForLog(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a}"`))
    .join(" ");
}
