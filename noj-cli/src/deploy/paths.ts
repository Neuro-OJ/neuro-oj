import type { DeployConfig } from "../config/types.ts";
import { COMPOSE_FILE } from "./compose.ts";

/** 返回安装目录下 run 目录。 */
export function runDirOf(config: DeployConfig): string {
  return `${config.install_dir}/run`;
}

/** 返回 compose 文件绝对路径。 */
export function composePathOf(config: DeployConfig): string {
  return `${config.install_dir}/${COMPOSE_FILE}`;
}
