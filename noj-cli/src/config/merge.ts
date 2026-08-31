import type { DeployConfig, SecretsConfig } from "./types.ts";

/**
 * 解析组件最终环境变量：
 * 最终 env = 全局 env + 组件 env（组件覆盖全局），
 * 组件 env 中的 ${KEY} 从（全局 env → secrets）依次解析。
 */
export function resolveComponentEnv(
  config: DeployConfig,
  secrets: SecretsConfig,
  componentName: string,
): Record<string, string> {
  const component = config.components[componentName];
  if (component === undefined) {
    throw new Error(`组件 ${componentName} 不存在`);
  }

  // 合并：先全局后组件，组件覆盖全局。
  const merged: Record<string, string> = { ...config.env, ...component.env };

  // 解析占位符：KEY 优先取全局 env，其次取 secrets。
  const lookup = (key: string): string | undefined =>
    config.env[key] ?? secrets.secrets[key];

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
      const val = lookup(key);
      return val === undefined ? `\${${key}}` : val;
    });
  }
  return out;
}
