import type {
  ComponentConfig,
  DeployConfig,
  DeployState,
  SecretsConfig,
} from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { fileExists } from "../util/fs.ts";
import { COMPOSE_FILE, ensureComposeFile } from "./compose.ts";
import { dockerDown, dockerPs, dockerUp } from "./docker.ts";
import { startManagedProcess, stopManagedProcess } from "../runtime/process.ts";
import { readPid } from "../runtime/pidfile.ts";
import { downIsNoOp, upIsNoOp, writeState } from "./state.ts";

/** deploy 命令运行选项。 */
export interface DeployOptions {
  dir: string;
  runner?: CommandRunner;
}

/** 单个组件运行状态。 */
export interface ComponentStatus {
  component: string;
  method: "docker" | "process";
  enabled: boolean;
  running: boolean;
}

/** deploy status 报告。 */
export interface DeployStatusReport {
  state: DeployState;
  components: ComponentStatus[];
}

/** 返回安装目录下 run 目录。 */
function runDirOf(config: DeployConfig): string {
  return `${config.install_dir}/run`;
}

/** 返回 compose 文件绝对路径。 */
function composePathOf(config: DeployConfig): string {
  return `${config.install_dir}/${COMPOSE_FILE}`;
}

/**
 * 启动 enabled 的 docker 组件（生成/复用 compose 后 `docker compose up -d --wait`）。
 * 返回是否全部成功。
 */
async function startDocker(
  runner: CommandRunner,
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<boolean> {
  const hasDocker = Object.values(config.components)
    .some((c) => c.enabled && c.method === "docker");
  if (!hasDocker) return true;
  const composePath = await ensureComposeFile(dir, config, secrets);
  const r = await dockerUp(runner, composePath);
  return r.code === 0;
}

/** 逐个启动 process 组件并记录 PID；返回是否全部成功。 */
async function startProcesses(
  runner: CommandRunner,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<boolean> {
  const runDir = runDirOf(config);
  let ok = true;
  for (const [name, comp] of Object.entries(config.components)) {
    if (!comp.enabled || comp.method !== "process") continue;
    const env = resolveComponentEnv(config, secrets, name);
    try {
      await startManagedProcess(
        runner,
        runDir,
        name,
        comp,
        env,
        config.install_dir,
      );
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** `deploy up`：running 时 no-op，否则启动 docker + process，写 running/partial。 */
export async function deployUp(opts: DeployOptions): Promise<DeployState> {
  const runner = opts.runner ?? realRunner();
  const { config, secrets } = await loadDeployment(opts.dir);
  if (upIsNoOp(config)) {
    console.log(`deploy up: ${config.state}`);
    return config.state;
  }
  const dockerOk = await startDocker(runner, opts.dir, config, secrets);
  const procOk = await startProcesses(runner, config, secrets);
  const state: DeployState = dockerOk && procOk ? "running" : "partial";
  await writeState(config, state, (c) => saveDeployment(opts.dir, c, secrets));
  console.log(`deploy up: ${state}`);
  return state;
}

/** 停止所有 process 组件。 */
async function stopProcesses(
  runner: CommandRunner,
  config: DeployConfig,
): Promise<void> {
  const runDir = runDirOf(config);
  for (const [name, comp] of Object.entries(config.components)) {
    if (comp.enabled && comp.method === "process") {
      await stopManagedProcess(runner, runDir, name);
    }
  }
}

/** `deploy down`：stopped 时 no-op，否则停进程 + docker down，写 stopped。 */
export async function deployDown(opts: DeployOptions): Promise<DeployState> {
  const runner = opts.runner ?? realRunner();
  const { config, secrets } = await loadDeployment(opts.dir);
  if (downIsNoOp(config)) {
    console.log(`deploy down: ${config.state}`);
    return config.state;
  }
  await stopProcesses(runner, config);
  const composePath = composePathOf(config);
  if (await fileExists(composePath)) {
    await dockerDown(runner, composePath);
  }
  await writeState(
    config,
    "stopped",
    (c) => saveDeployment(opts.dir, c, secrets),
  );
  console.log("deploy down: stopped");
  return config.state;
}

/** `deploy restart`：先 down 再 up（down 在 stopped 时 no-op）。 */
export async function deployRestart(opts: DeployOptions): Promise<DeployState> {
  await deployDown(opts);
  return deployUp(opts);
}

/** 探测单个组件的运行状态。 */
async function componentRunning(
  runner: CommandRunner,
  config: DeployConfig,
  name: string,
  comp: ComponentConfig,
): Promise<boolean> {
  if (!comp.enabled) return false;
  if (comp.method === "docker") {
    const composePath = composePathOf(config);
    if (!(await fileExists(composePath))) return false;
    const r = await dockerPs(runner, composePath);
    return r.code === 0 && r.stdout.includes(name);
  }
  const pid = await readPid(runDirOf(config), name);
  return pid !== null;
}

/** `deploy status`：只做最小检查，配置损坏时仍可查看（返回 uninitialized）。 */
export async function deployStatus(
  opts: DeployOptions,
): Promise<DeployStatusReport> {
  const runner = opts.runner ?? realRunner();
  let config: DeployConfig;
  try {
    ({ config } = await loadDeployment(opts.dir));
  } catch {
    return { state: "uninitialized", components: [] };
  }
  const components: ComponentStatus[] = [];
  for (const [name, comp] of Object.entries(config.components)) {
    const running = await componentRunning(runner, config, name, comp);
    components.push({
      component: name,
      method: comp.method,
      enabled: comp.enabled,
      running,
    });
  }
  return { state: config.state, components };
}
