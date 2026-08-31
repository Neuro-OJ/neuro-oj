/** noj-cli 版本号，与 deno.json 的 version 保持一致。 */
export const VERSION = "0.1.0";

// 配置模型
export * from "./config/types.ts";
export { loadDeployment } from "./config/load.ts";
export { saveDeployment } from "./config/save.ts";
export { validateConfig } from "./config/validate.ts";
export { resolveComponentEnv } from "./config/merge.ts";
export {
  DEPLOY_FILE,
  DEPLOY_FILE_MODE,
  SECRETS_FILE,
  SECRETS_FILE_MODE,
} from "./config/io.ts";

// 状态机与工具
export { transition } from "./state/machine.ts";
export type { DeployAction, TransitionResult } from "./state/machine.ts";
export { findDeployDir } from "./util/find_deploy_dir.ts";
