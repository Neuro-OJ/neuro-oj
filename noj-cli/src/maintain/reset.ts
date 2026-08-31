import { loadDeployment } from "../config/load.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import type { DeployState } from "../config/types.ts";
import { deployDown } from "../deploy/deploy.ts";
import type { BackupDriver } from "./backup_driver.ts";

/** maintain reset 选项。 */
export interface ResetOptions {
  dir: string;
  confirm: boolean;
  includeDeployConfigs?: boolean;
  driver?: BackupDriver;
}

/** 先确保部署 down，返回 down 后状态。 */
function ensureStopped(dir: string): Promise<DeployState> {
  return deployDown({ dir });
}

/**
 * maintain reset：
 * - 默认：先 down → 清数据 → 状态置 stopped，保留配置文件。
 * - --include-deploy-configs：清数据后连 noj-deploy.json / noj-secrets.json 一起删 → 状态置 uninitialized。
 */
export async function maintainReset(opts: ResetOptions): Promise<DeployState> {
  if (!opts.confirm) {
    throw new Error("reset 需要二次确认：--confirm");
  }
  await ensureStopped(opts.dir);
  const driver = opts.driver!;
  const { config, secrets } = await loadDeployment(opts.dir);
  await driver.clearData(config, secrets);
  if (opts.includeDeployConfigs) {
    await Deno.remove(`${opts.dir}/${DEPLOY_FILE}`).catch(() => {});
    await Deno.remove(`${opts.dir}/${SECRETS_FILE}`).catch(() => {});
    return "uninitialized";
  }
  return "stopped";
}
