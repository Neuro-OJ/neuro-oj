/** 生产服务生命周期命令。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { prodComposeArgs, runProdCompose } from "./compose.ts";

export interface ProdLifecycleOptions {
  envFile: string;
  composeFile: string;
  dryRun?: boolean;
  follow?: boolean;
  services?: string[];
}

export async function prodStart(
  opts: ProdLifecycleOptions,
  runner?: CommandRunner,
): Promise<number> {
  if (opts.dryRun) {
    console.log("[dry-run] docker compose up -d");
    return 0;
  }
  return await runProdCompose(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    ["up", "-d", "--remove-orphans", ...(opts.services ?? [])],
    runner,
  );
}

export async function prodStop(
  opts: ProdLifecycleOptions,
  runner?: CommandRunner,
): Promise<number> {
  if (opts.dryRun) {
    console.log("[dry-run] docker compose stop");
    return 0;
  }
  return await runProdCompose(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    ["stop", ...(opts.services ?? [])],
    runner,
  );
}

export async function prodRestart(
  opts: ProdLifecycleOptions,
  runner?: CommandRunner,
): Promise<number> {
  const stop = await prodStop(opts, runner);
  if (stop !== 0) return stop;
  return await prodStart(opts, runner);
}

export async function prodStatus(
  opts: ProdLifecycleOptions,
  runner?: CommandRunner,
): Promise<number> {
  return await runProdCompose(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    ["ps", ...(opts.services ?? [])],
    runner,
  );
}

export async function prodLogs(
  opts: ProdLifecycleOptions,
  runner?: CommandRunner,
): Promise<number> {
  const args = ["logs", "--tail=200"];
  if (opts.follow) args.push("--follow");
  args.push(...(opts.services ?? []));
  return await runProdCompose(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    args,
    runner,
  );
}

export function prodComposeArgsForTesting(
  opts: ProdLifecycleOptions,
  args: string[],
): string[] {
  return prodComposeArgs(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    args,
  );
}

export function useRealRunner(): CommandRunner {
  return realRunner();
}
