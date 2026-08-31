import type { ComponentConfig } from "../config/types.ts";
import type { CommandRunner, SpawnOpts } from "./command.ts";
import { readPid, removePid, writePid } from "./pidfile.ts";
import { logPath } from "./logfile.ts";

/** 由 ComponentConfig 生成进程启动参数。 */
export function processLaunch(
  comp: ComponentConfig,
  env: Record<string, string>,
  cwd: string,
): SpawnOpts {
  if (comp.method !== "process") {
    throw new Error("processLaunch 仅支持 method=process 的组件");
  }
  if (comp.dev_command) {
    const parts = comp.dev_command.trim().split(/\s+/);
    return { cmd: parts[0]!, args: parts.slice(1), cwd, env };
  }
  return { cmd: comp.binary ?? "noj-server", args: [], cwd, env };
}

/** 启动一个 process 组件：spawn 后记录 PID，返回 PID。 */
export async function startManagedProcess(
  runner: CommandRunner,
  runDir: string,
  component: string,
  comp: ComponentConfig,
  env: Record<string, string>,
  cwd: string,
): Promise<{ pid: number }> {
  const launch = processLaunch(comp, env, cwd);
  const log = logPath(runDir, component);
  await Deno.mkdir(`${runDir}/logs`, { recursive: true });
  const handle = runner.spawn({ ...launch, stdoutFile: log, stderrFile: log });
  await writePid(runDir, component, handle.pid);
  return { pid: handle.pid };
}

/** 停止 process 组件：读 PID → kill -TERM → 清 PID 文件；无 PID 文件则 no-op。 */
export async function stopManagedProcess(
  runner: CommandRunner,
  runDir: string,
  component: string,
): Promise<void> {
  const pid = await readPid(runDir, component);
  if (pid === null) return;
  await runner.run("kill", ["-TERM", String(pid)]);
  await removePid(runDir, component);
}
