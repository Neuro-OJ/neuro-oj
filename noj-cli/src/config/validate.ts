import type { DeployConfig, SecretsConfig } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

/** 提取字符串中所有 ${KEY} 占位符引用的 key。 */
function referencedKeys(env: Record<string, string>): string[] {
  const keys = new Set<string>();
  for (const value of Object.values(env)) {
    for (const m of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
      keys.add(m[1]!);
    }
  }
  return [...keys];
}

/** 校验敏感项：被引用的 secret 必须存在且（对 JWT/TFA）长度 ≥ 32。 */
function validateSecrets(
  cfg: DeployConfig,
  secrets: SecretsConfig,
  issues: ValidationIssue[],
): void {
  const longKeys = new Set(["JWT_SECRET", "TFA_ENCRYPTION_KEY"]);
  for (const [comp, compCfg] of Object.entries(cfg.components)) {
    if (!compCfg.enabled) continue;
    const keys = new Set(referencedKeys(compCfg.env));
    if (compCfg.command) {
      for (const m of compCfg.command.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
        keys.add(m[1]!);
      }
    }
    for (const key of keys) {
      const value = cfg.env[key] ?? secrets.secrets[key];
      if (value === undefined) {
        issues.push({
          path: `components.${comp}.env.${key}`,
          message: `组件 ${comp} 引用了缺失的 secret ${key}`,
        });
        continue;
      }
      if (longKeys.has(key) && value.length < 32) {
        issues.push({
          path: `secrets.${key}`,
          message: `secret ${key} 长度不足 32，当前 ${value.length}`,
        });
      }
    }
  }
}

/** 校验部署配置与密钥；返回问题列表，合法时为空数组。 */
export function validateConfig(
  config: DeployConfig,
  secrets: SecretsConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (config.schema_version !== SCHEMA_VERSION) {
    issues.push({
      path: "schema_version",
      message: `期望 ${SCHEMA_VERSION}，实际 ${config.schema_version}`,
    });
  }
  if (config.env === undefined) {
    issues.push({ path: "env", message: "缺少 env 字段" });
  }
  if (
    config.components === undefined || typeof config.components !== "object"
  ) {
    issues.push({ path: "components", message: "缺少 components 字段" });
  } else {
    for (const [name, comp] of Object.entries(config.components)) {
      if (typeof comp.enabled !== "boolean") {
        issues.push({
          path: `components.${name}.enabled`,
          message: "enabled 必须为布尔值",
        });
      }
      if (comp.method !== "docker" && comp.method !== "process") {
        issues.push({
          path: `components.${name}.method`,
          message: "method 必须为 docker 或 process",
        });
      }
    }
  }

  validateSecrets(config, secrets, issues);
  return issues;
}
