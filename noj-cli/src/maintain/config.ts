import type { DeployConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { validateConfig, type ValidationIssue } from "../config/validate.ts";

/** 判断 key 是否敏感（含 SECRET/PASSWORD/TOKEN/KEY，不区分大小写）。 */
function isSensitiveKey(key: string): boolean {
  const k = key.toUpperCase();
  return (
    k.includes("SECRET") || k.includes("PASSWORD") || k.includes("TOKEN") ||
    k.includes("KEY")
  );
}

/** 深拷贝配置并把敏感 env 值替换为 ***。 */
export function maskSecrets(config: DeployConfig): DeployConfig {
  const copy: DeployConfig = JSON.parse(JSON.stringify(config)) as DeployConfig;
  for (const k of Object.keys(copy.env)) {
    if (isSensitiveKey(k)) copy.env[k] = "***";
  }
  for (const comp of Object.values(copy.components)) {
    for (const k of Object.keys(comp.env)) {
      if (isSensitiveKey(k)) comp.env[k] = "***";
    }
  }
  return copy;
}

/** 按 . 分隔路径设置值；中间层不存在则创建对象。 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 把命令行字符串解析为 JSON 值：true/false → boolean，纯数字 → number，否则字符串。 */
export function parseConfigValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** config check：只校验，不改变状态。 */
export async function configCheck(dir: string): Promise<ValidationIssue[]> {
  const { config, secrets } = await loadDeployment(dir);
  return validateConfig(config, secrets);
}

/** config show：输出脱敏后的 JSON 文本。 */
export async function configShow(dir: string): Promise<string> {
  const { config } = await loadDeployment(dir);
  return JSON.stringify(maskSecrets(config), null, 2);
}

/** config set：修改单个配置项，写入前校验，写入后保持权限。 */
export async function configSet(
  dir: string,
  key: string,
  value: string,
): Promise<void> {
  const { config, secrets } = await loadDeployment(dir);
  setByPath(
    config as unknown as Record<string, unknown>,
    key,
    parseConfigValue(value),
  );
  const issues = validateConfig(config, secrets);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`配置校验失败: ${first.path} ${first.message}`);
  }
  await saveDeployment(dir, config, secrets);
}
