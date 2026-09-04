import type {
  ComponentConfig,
  DeployConfig,
  DeployState,
  SecretsConfig,
} from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import { validateConfig } from "../config/validate.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { fileExists } from "../util/fs.ts";
import { COMPOSE_FILE, ensureComposeFile } from "./compose.ts";
import { composePathOf, runDirOf } from "./paths.ts";
import { dockerDown, dockerPs, dockerUp } from "./docker.ts";
import { startManagedProcess, stopManagedProcess } from "../runtime/process.ts";
import { ensureNojServerBinary } from "../runtime/download.ts";
import { readPid, removePid } from "../runtime/pidfile.ts";
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
      let resolvedComp = comp;
      if (
        !comp.dev_command &&
        (comp.binary === "noj-server" ||
          (comp.binary === undefined && name === "server"))
      ) {
        const bin = await ensureNojServerBinary({
          installDir: config.install_dir,
          version: config.version.noj_server,
        });
        resolvedComp = { ...comp, binary: bin };
      }
      await startManagedProcess(
        runner,
        runDir,
        name,
        resolvedComp,
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
  const issues = validateConfig(config, secrets);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`deploy up 配置校验失败: ${first.path} ${first.message}`);
  }
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
  let config: DeployConfig;
  let secrets: SecretsConfig;
  try {
    ({ config, secrets } = await loadDeployment(opts.dir));
  } catch (e) {
    // 配置损坏时仍尽力停止：docker compose down + 清理 PID 文件
    console.error(
      `deploy down: 配置读取失败，尝试尽力停止: ${(e as Error).message}`,
    );
    const composePath = `${opts.dir}/${COMPOSE_FILE}`;
    if (await fileExists(composePath)) {
      await dockerDown(runner, composePath);
    }
    const runDir = `${opts.dir}/run`;
    try {
      for await (const entry of Deno.readDir(runDir)) {
        if (!entry.name.endsWith(".pid")) continue;
        const name = entry.name.slice(0, -4);
        const pid = await readPid(runDir, name);
        if (pid !== null) {
          await runner.run("kill", ["-TERM", String(pid)]);
        }
        await removePid(runDir, name);
      }
    } catch {
      // run 目录不存在或不可读时忽略
    }
    console.log("deploy down: stopped（配置损坏，已尽力停止）");
    return "stopped";
  }
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
    if (r.code !== 0) return false;
    return r.stdout.split("\n").some((line) =>
      line.split(/\s+/).some((field) =>
        field === name || field === `noj-${name}`
      )
    );
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
