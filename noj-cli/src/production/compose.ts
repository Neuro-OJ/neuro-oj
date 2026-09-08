/** 生产 Docker Compose 执行辅助。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";

export interface ProdComposeOptions {
  envFile: string;
  composeFile: string;
  projectName?: string;
}

export function prodComposeArgs(
  opts: ProdComposeOptions,
  args: string[],
): string[] {
  const base = ["compose"];
  if (opts.projectName) {
    base.push("--project-name", opts.projectName);
  }
  base.push("--env-file", opts.envFile, "--file", opts.composeFile);
  return [...base, ...args];
}

export async function runProdCompose(
  opts: ProdComposeOptions,
  args: string[],
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  const res = await r.run("docker", prodComposeArgs(opts, args));
  return res.code;
}

export async function waitForHealthy(
  opts: ProdComposeOptions,
  runner?: CommandRunner,
): Promise<void> {
  const code = await runProdCompose(
    opts,
    ["up", "-d", "--wait"],
    runner,
  );
  if (code !== 0) throw new Error("docker compose up --wait 失败");
}
