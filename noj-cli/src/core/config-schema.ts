/**
 * 生产配置 schema（唯一事实源）。
 *
 * 本模块替换 `scripts/deploy/deploy.sh` 中散落的硬编码键名数组，键清单与判定
 * 逻辑逐字对照 bash：
 * - `check_required_values()` 的 19 个必需键（deploy.sh:686-692）
 * - judge 分支的额外 2 个键（deploy.sh:702-710）
 * - `is_placeholder()` 的 case 模式（deploy.sh:667-674）
 * - `judge_enabled()` 的真值集合（deploy.sh:676-682）
 */

/** 单个环境变量键的 schema 描述。 */
export interface EnvKeySpec {
  /** 环境变量名（.env.prod 中的键）。 */
  key: string;
  /** 是否无条件必需（judge 条件键见 {@link JUDGE_KEYS}）。 */
  required: boolean;
  /** 是否敏感值（口令 / 密钥），用于展示脱敏。 */
  secret?: boolean;
  /** 供向导展示的简短说明。 */
  note?: string;
}

/**
 * bash `check_required_values` 硬编码的 19 个必需键（顺序与 bash 一致）。
 */
export const ENV_KEYS: readonly EnvKeySpec[] = [
  { key: "NOJ_VERSION", required: true, note: "不可变 Release 标签" },
  { key: "DOMAIN", required: true, note: "对外域名或服务器 IP" },
  { key: "APP_URL", required: true, note: "完整应用地址（http(s)://）" },
  {
    key: "CORS_ALLOWED_ORIGINS",
    required: true,
    note: "CORS 白名单（逗号分隔）",
  },
  { key: "TRUSTED_PROXIES", required: true, note: "可信代理网段" },
  { key: "POSTGRES_PASSWORD", required: true, secret: true },
  { key: "REDIS_PASSWORD", required: true, secret: true },
  { key: "MINIO_ROOT_USER", required: true },
  { key: "MINIO_ROOT_PASSWORD", required: true, secret: true },
  { key: "S3_ACCESS_KEY", required: true, secret: true },
  { key: "S3_SECRET_KEY", required: true, secret: true },
  { key: "S3_BUCKET", required: true },
  { key: "S3_ENDPOINT", required: true },
  { key: "STORAGE_PROVIDER", required: true },
  { key: "JWT_SECRET", required: true, secret: true },
  { key: "TFA_ENCRYPTION_KEY", required: true, secret: true },
  { key: "NOJ_LLM_SERVICE_TOKEN", required: true, secret: true },
  { key: "NOJ_LLM_STORE_KEY", required: true, secret: true },
  { key: "EMAIL_PROVIDER", required: true },
];

/** `JUDGE_ENABLED` 为真时额外必需的键（deploy.sh:703）。 */
export const JUDGE_KEYS: readonly string[] = [
  "JUDGE_DOCKER_SOCKET",
  "JUDGE_DOCKER_SOCKET_GID",
];

/** `JUDGE_ENABLED` 判定为假的值（deploy.sh:678）。 */
const JUDGE_FALSY: ReadonlySet<string> = new Set([
  "false",
  "FALSE",
  "no",
  "NO",
  "0",
  "off",
  "OFF",
]);

/**
 * 判断 judge 是否启用，真值集合与 bash `judge_enabled()` 一致。
 *
 * 注意 bash 把**空/未设置**视为启用（deploy.sh:679），因此缺省要求 judge 键。
 * 对不在真/假集合内的非法值，bash 会直接 fail；这里按 fail-safe 处理为启用，
 * 使非法值仍会让校验失败，而不是静默跳过 judge 要求。
 */
function judgeEnabled(env: Record<string, string>): boolean {
  const raw = env["JUDGE_ENABLED"] ?? "";
  return !JUDGE_FALSY.has(raw);
}

/**
 * 占位值 / 未配置判定，逐字对应 bash `is_placeholder()`（deploy.sh:667-674）。
 *
 * 语义要点（与 bash 一致）：
 * - 空串或 undefined → true；
 * - bash 的 `case` 区分大小写；
 * - `*example*` 为**子串**匹配，故 `real.example.com` 亦为占位值；
 * - `test` / `xxx*` 为整体匹配（`testing` / `vxx` 不算）。
 */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  return (
    value.includes("change-me") ||
    value.includes("change-this") ||
    value.includes("changeme") ||
    value.includes("example") ||
    value.includes("placeholder") ||
    value.includes("replace-me") ||
    value.includes("your-") ||
    value === "test" ||
    value.startsWith("xxx")
  );
}

/**
 * 按 bash `check_required_values` 语义校验环境变量。
 *
 * 返回两个互斥集合，其并集恰为 bash 的失败集合：
 * - `missing`：键缺失或为空串（未配置）；
 * - `placeholder`：键有值但命中占位值黑名单。
 *
 * `JUDGE_ENABLED` 为真时，额外要求 {@link JUDGE_KEYS}。
 */
export function validateEnv(
  env: Record<string, string>,
): { missing: string[]; placeholder: string[] } {
  const missing: string[] = [];
  const placeholder: string[] = [];
  const keys: readonly string[] = judgeEnabled(env)
    ? [...ENV_KEYS.map((spec) => spec.key), ...JUDGE_KEYS]
    : ENV_KEYS.map((spec) => spec.key);

  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === "") {
      missing.push(key);
    } else if (isPlaceholder(value)) {
      placeholder.push(key);
    }
  }
  return { missing, placeholder };
}
