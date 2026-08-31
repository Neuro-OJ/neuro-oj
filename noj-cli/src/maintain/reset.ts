import { loadDeployment } from "../config/load.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import type { DeployState } from "../config/types.ts";
import { deployDown } from "../deploy/deploy.ts";
import { COMPOSE_FILE, ensureComposeFile } from "../deploy/compose.ts";
import { dockerDown, dockerUpServices } from "../deploy/docker.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { BackupDriver } from "./backup_driver.ts";

/** maintain reset 选项。 */
export interface ResetOptions {
  dir: string;
  confirm: boolean;
  includeDeployConfigs?: boolean;
  driver?: BackupDriver;
  runner?: CommandRunner;
}

/**
 * maintain reset：
 * - 默认：先 down → 起基础设施 → 清数据 → 停基础设施 → 状态置 stopped，保留配置文件。
 * - --include-deploy-configs：清数据后连 noj-deploy.json / noj-secrets.json 一起删 → 状态置 uninitialized。
 */
export async function maintainReset(opts: ResetOptions): Promise<DeployState> {
  if (!opts.confirm) {
    throw new Error("reset 需要二次确认：--confirm");
  }
  const runner = opts.runner ?? realRunner();
  const driver = opts.driver!;
  const { config, secrets } = await loadDeployment(opts.dir);
  await deployDown({ dir: opts.dir, runner });
  const infraServices = Object.entries(config.components)
    .filter(([name, c]) =>
      c.enabled && c.method === "docker" &&
      (name === "postgres" || name === "redis" || name === "minio")
    )
    .map(([name]) => name);
  let infraStarted = false;
  try {
    if (infraServices.length > 0) {
      const composePath = `${opts.dir}/${COMPOSE_FILE}`;
      await ensureComposeFile(opts.dir, config, secrets);
      infraStarted = true;
      const upRes = await dockerUpServices(runner, composePath, infraServices);
      if (upRes.code !== 0) {
        throw new Error(
          `reset 前启动基础设施失败: ${upRes.stderr || upRes.stdout}`,
        );
      }
    }
    await driver.clearData(config, secrets);
    if (opts.includeDeployConfigs) {
      await Deno.remove(`${opts.dir}/${DEPLOY_FILE}`).catch(() => {});
      await Deno.remove(`${opts.dir}/${SECRETS_FILE}`).catch(() => {});
      return "uninitialized";
    }
    return "stopped";
  } finally {
    if (infraStarted) {
      await dockerDown(runner, `${opts.dir}/${COMPOSE_FILE}`);
    }
  }
}
