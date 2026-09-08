/** restore-drill 演练 Compose 辅助。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { RestoreDrillOptions } from "./options.ts";

export interface DrillComposePaths {
  envFile: string;
  overrideFile: string;
  composeFile: string;
}

export function renderDrillOverride(subnet: string): string {
  return `# restore-drill 自动生成的隔离覆盖：独立子网，避免与生产 noj-net 冲突。
services:
  verifier:
    image: denoland/deno:debian-2.9.5@sha256:5d46f925d213e9adaf18a0664b291fe973c91ba7b929572877610dcaaf09ee2b
    networks:
      - noj-net
networks:
  noj-net:
    ipam:
      config:
        - subnet: ${subnet}
`;
}

export function writeDrillOverride(file: string, subnet: string): void {
  Deno.writeTextFileSync(file, renderDrillOverride(subnet));
  Deno.chmodSync(file, 0o600);
}

export function composeArgs(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  extra: string[],
  includeJudgeProfile = true,
): string[] {
  const args = [
    "compose",
    "--project-name",
    opts.projectName,
    "--env-file",
    paths.envFile,
    "--file",
    paths.composeFile,
    "--file",
    paths.overrideFile,
  ];
  if (includeJudgeProfile && !opts.skipJudge) {
    args.push("--profile", "judge");
  }
  return [...args, ...extra];
}

export async function runDrillCompose(
  opts: RestoreDrillOptions,
  paths: DrillComposePaths,
  args: string[],
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  const full = composeArgs(opts, paths, args);
  const res = await r.run("docker", full);
  return res.code;
}
