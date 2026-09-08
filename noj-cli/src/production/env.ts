/** 生产 .env.prod 读取/写入/校验。 */

const REQUIRED_KEYS = [
  "NOJ_VERSION",
  "APP_URL",
  "DOMAIN",
  "CORS_ALLOWED_ORIGINS",
  "TRUSTED_PROXIES",
  "POSTGRES_USER",
  "POSTGRES_DB",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "JWT_SECRET",
  "TFA_ENCRYPTION_KEY",
  "NOJ_LLM_SERVICE_TOKEN",
  "NOJ_LLM_STORE_KEY",
  "ADMIN_EMAIL",
  "ADMIN_PASS",
];

const PLACEHOLDER_PATTERNS = [
  "change-me",
  "changeme",
  "example",
  "placeholder",
  "replace-me",
  "your-",
];

export function loadProdEnv(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of Deno.readTextFileSync(file).split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) values[key] = value;
    }
  } catch {
    // 文件不存在时返回空
  }
  return values;
}

export function saveProdEnv(
  file: string,
  values: Record<string, string>,
): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  Deno.writeTextFileSync(file, lines.join("\n") + "\n");
  Deno.chmodSync(file, 0o600);
}

export function setProdEnv(
  file: string,
  key: string,
  value: string,
): void {
  const values = loadProdEnv(file);
  values[key] = value;
  saveProdEnv(file, values);
}

function isPlaceholder(value: string): boolean {
  if (value === "latest" || value === "main" || value.startsWith("xxx")) {
    return true;
  }
  return PLACEHOLDER_PATTERNS.some((p) => value.includes(p));
}

function isVersion(value: string): boolean {
  return /^v?\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(value);
}

/** 返回配置问题列表；空数组表示通过。 */
export function validateProdEnv(
  file: string,
  opts: { requireSecrets?: boolean } = {},
): string[] {
  const problems: string[] = [];
  try {
    const mode = Deno.statSync(file).mode! & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      problems.push(`生产配置权限必须为 600 或 400：${file}`);
    }
  } catch {
    problems.push(`生产配置文件不存在：${file}`);
    return problems;
  }

  const values = loadProdEnv(file);
  for (const key of REQUIRED_KEYS) {
    if (opts.requireSecrets === false && key.endsWith("_PASSWORD")) continue;
    if (key === "ADMIN_PASS" && opts.requireSecrets === false) continue;
    const value = values[key];
    if (!value || isPlaceholder(value)) {
      problems.push(`${key} 未配置或仍是占位值`);
    }
  }
  if (!values["NOJ_VERSION"] || !isVersion(values["NOJ_VERSION"])) {
    problems.push("NOJ_VERSION 必须是不可变 Release 标签，如 v0.1.0");
  }
  return problems;
}

/** 显示配置（脱敏敏感值）。 */
export function showProdEnv(file: string): string {
  const values = loadProdEnv(file);
  const sensitive = new Set([
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "MINIO_ROOT_PASSWORD",
    "S3_SECRET_KEY",
    "JWT_SECRET",
    "TFA_ENCRYPTION_KEY",
    "NOJ_LLM_SERVICE_TOKEN",
    "NOJ_LLM_STORE_KEY",
    "ADMIN_PASS",
  ]);
  const lines: string[] = [];
  for (
    const [k, v] of Object.entries(values).sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    lines.push(`${k}=${sensitive.has(k) ? "***" : v}`);
  }
  return lines.join("\n") + "\n";
}
