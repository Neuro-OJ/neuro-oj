/** 生产安装/升级/卸载命令。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { setProdEnv, validateProdEnv } from "./env.ts";
import { prodComposeArgs, runProdCompose } from "./compose.ts";

export interface ProdInstallOptions {
  dir: string;
  envFile: string;
  composeFile: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
  version?: string;
  uninstallAll?: boolean;
  yes?: boolean;
  panel?: "auto" | "baota" | "none";
}

export async function prodInstall(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    const problems = validateProdEnv(opts.envFile);
    if (problems.length > 0) {
      throw new Error(`生产配置校验失败：${problems.join("; ")}`);
    }
    if (opts.dryRun) {
      console.log("[dry-run] docker compose pull && up -d");
      return 0;
    }
    const pull = await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["pull"],
      r,
    );
    if (pull !== 0) return pull;
    return await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["up", "-d", "--remove-orphans"],
      r,
    );
  } catch (e) {
    console.error(`install: ${(e as Error).message}`);
    return 1;
  }
}

export async function prodUpdate(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    if (opts.version !== undefined && !opts.dryRun) {
      setProdEnv(opts.envFile, "NOJ_VERSION", opts.version);
    }
    if (opts.dryRun) {
      console.log("[dry-run] docker compose pull && up -d");
      return 0;
    }
    const pull = await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["pull"],
      r,
    );
    if (pull !== 0) return pull;
    return await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["up", "-d", "--remove-orphans"],
      r,
    );
  } catch (e) {
    console.error(`update: ${(e as Error).message}`);
    return 1;
  }
}

export async function prodUninstall(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    if (!opts.yes) {
      throw new Error("uninstall 需要 --yes 确认");
    }
    const args = ["down", "--remove-orphans"];
    if (opts.uninstallAll) args.push("--volumes");
    if (opts.dryRun) {
      console.log(`[dry-run] docker compose ${args.join(" ")}`);
      return 0;
    }
    return await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      args,
      r,
    );
  } catch (e) {
    console.error(`uninstall: ${(e as Error).message}`);
    return 1;
  }
}

export function useProdComposeArgsForTesting(
  opts: ProdInstallOptions,
  args: string[],
): string[] {
  return prodComposeArgs(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    args,
  );
}
