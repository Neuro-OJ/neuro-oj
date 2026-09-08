/** 生产配置命令。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import {
  loadProdEnv,
  setProdEnv,
  showProdEnv,
  validateProdEnv,
} from "./env.ts";
import { runProdCompose } from "./compose.ts";

export interface ProdConfigOptions {
  envFile: string;
  composeFile: string;
  dryRun?: boolean;
}

export async function prodConfigCheck(
  opts: ProdConfigOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  const problems = validateProdEnv(opts.envFile);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  if (opts.dryRun) {
    console.log("[dry-run] docker compose config --quiet");
    return 0;
  }
  const code = await runProdCompose(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    ["config", "--quiet"],
    r,
  );
  if (code !== 0) {
    console.error("docker compose config 校验失败");
    return 1;
  }
  console.log("配置校验通过");
  return 0;
}

export function prodConfigShow(opts: ProdConfigOptions): string {
  return showProdEnv(opts.envFile);
}

export function prodConfigSet(
  opts: ProdConfigOptions,
  key: string,
  value: string,
  _runner?: CommandRunner,
): Promise<number> {
  try {
    if (opts.dryRun) {
      console.log(`[dry-run] 将设置 ${key}=${value}`);
      return Promise.resolve(0);
    }
    const env = loadProdEnv(opts.envFile);
    env[key] = value;
    setProdEnv(opts.envFile, key, value);
    const problems = validateProdEnv(opts.envFile);
    if (problems.length > 0) {
      throw new Error(`写入后配置校验失败：${problems.join("; ")}`);
    }
    return Promise.resolve(0);
  } catch (e) {
    console.error(`config set: ${(e as Error).message}`);
    return Promise.resolve(1);
  }
}
