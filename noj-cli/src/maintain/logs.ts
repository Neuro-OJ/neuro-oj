import type { DeployConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { composePathOf, runDirOf } from "../deploy/paths.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { followLogFile, logPath, readRecentLog } from "../runtime/logfile.ts";
import { colorFor, prefixLine } from "../util/color.ts";

/** maintain logs 运行选项。 */
export interface LogsOptions {
  dir: string;
  modules: string[];
  follow: boolean;
  runner?: CommandRunner;
}

/** 单个模块的最近日志。 */
export interface ModuleLogs {
  module: string;
  lines: string[];
}

/** 解析 modules 参数：undefined/"all" → 全部 enabled 组件；否则逗号分隔并过滤。 */
export function parseModulesArg(
  arg: string | undefined,
  config: DeployConfig,
): string[] {
  const enabled = Object.entries(config.components)
    .filter(([, c]) => c.enabled)
    .map(([name]) => name);
  if (arg === undefined || arg === "all") return enabled;
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && enabled.includes(s));
}

/** 收集各模块最近日志（非 follow）。 */
export async function collectLogs(opts: LogsOptions): Promise<ModuleLogs[]> {
  const runner = opts.runner ?? realRunner();
  const { config } = await loadDeployment(opts.dir);
  const out: ModuleLogs[] = [];
  for (const name of opts.modules) {
    const comp = config.components[name];
    if (!comp || !comp.enabled) continue;
    if (comp.method === "docker") {
      const r = await runner.run("docker", [
        "compose",
        "-f",
        composePathOf(config),
        "logs",
        "--no-color",
        name,
      ]);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      out.push({ module: name, lines });
    } else {
      const text = await readRecentLog(
        logPath(runDirOf(config), name),
        64 * 1024,
      );
      const lines = text.split("\n").filter((l) => l.length > 0);
      out.push({ module: name, lines });
    }
  }
  return out;
}

/** follow 各模块日志；onLine 收到未加前缀的原始行。 */
export async function followLogs(
  opts: LogsOptions,
  onLine: (module: string, line: string) => void,
): Promise<void> {
  const runner = opts.runner ?? realRunner();
  const { config } = await loadDeployment(opts.dir);
  const signal = { aborted: false };
  const dockerTasks: Promise<void>[] = [];
  const processTasks: Promise<void>[] = [];
  for (const name of opts.modules) {
    const comp = config.components[name];
    if (!comp || !comp.enabled) continue;
    if (comp.method === "docker") {
      if (runner.stream) {
        dockerTasks.push(
          runner.stream(
            "docker",
            [
              "compose",
              "-f",
              composePathOf(config),
              "logs",
              "--no-color",
              "--follow",
              name,
            ],
            (l) => onLine(name, l),
          ).then(() => {}),
        );
      }
    } else {
      processTasks.push(
        followLogFile(
          logPath(runDirOf(config), name),
          (l) => onLine(name, l),
          signal,
        ),
      );
    }
  }
  // 等所有 docker stream 结束，再停止 process follow
  await Promise.all(dockerTasks);
  // 给 process 日志轮询一个短窗口，确保已追加内容被读取
  await new Promise((r) => setTimeout(r, 200));
  signal.aborted = true;
  await Promise.all(processTasks);
}

/** maintain logs 命令入口：非 follow 打印最近日志，follow 逐行打印。 */
export async function maintainLogs(opts: LogsOptions): Promise<number> {
  if (opts.follow) {
    await followLogs(opts, (module, line) => {
      console.log(prefixLine(module, line, colorFor(module)));
    });
    return 0;
  }
  const logs = await collectLogs(opts);
  for (const m of logs) {
    for (const line of m.lines) {
      console.log(prefixLine(m.module, line, colorFor(m.module)));
    }
  }
  return 0;
}
