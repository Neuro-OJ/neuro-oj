import type { ComponentConfig } from "../config/types.ts";
import type { CommandRunner, SpawnOpts } from "./command.ts";
import { readPid, removePid, writePid } from "./pidfile.ts";
import { logPath } from "./logfile.ts";
import { loadDeployment } from "../config/load.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import { realRunner } from "./command.ts";
import { ensureNojServerBinary } from "./download.ts";

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

/** run-server 选项。 */
export interface RunServerOptions {
  dir: string;
  runner?: CommandRunner;
}

/** 前台运行 noj-server 二进制（不启动 Docker/UI），返回进程退出码。 */
export async function runServerForeground(
  opts: RunServerOptions,
): Promise<number> {
  const { config, secrets } = await loadDeployment(opts.dir);
  const comp = config.components["server"];
  if (comp === undefined || !comp.enabled) {
    throw new Error("server 组件未启用");
  }
  if (comp.method !== "process") {
    throw new Error("run-server 仅支持 method=process 的 server 组件");
  }
  const env = resolveComponentEnv(config, secrets, "server");
  let resolvedComp = comp;
  if (
    !comp.dev_command &&
    (comp.binary === "noj-server" || comp.binary === undefined)
  ) {
    const bin = await ensureNojServerBinary({
      installDir: config.install_dir,
      version: config.version.noj_server,
    });
    resolvedComp = { ...comp, binary: bin };
  }
  const launch = processLaunch(resolvedComp, env, config.install_dir);
  const handle = (opts.runner ?? realRunner()).spawn({
    ...launch,
    cwd: config.install_dir,
    env,
  });
  return await handle.wait();
}
