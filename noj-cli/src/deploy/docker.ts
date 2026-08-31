import type { CmdResult, CommandRunner } from "../runtime/command.ts";

/** `docker compose -f <path> up -d --wait`。 */
export function dockerUp(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", [
    "compose",
    "-f",
    composePath,
    "up",
    "-d",
    "--wait",
  ]);
}

/** `docker compose -f <path> down`（不 `-v`，保留数据卷）。 */
export function dockerDown(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", ["compose", "-f", composePath, "down"]);
}

/** `docker compose -f <path> ps`。 */
export function dockerPs(
  runner: CommandRunner,
  composePath: string,
): Promise<CmdResult> {
  return runner.run("docker", ["compose", "-f", composePath, "ps"]);
}
