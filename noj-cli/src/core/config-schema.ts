/**
 * 生产配置 schema（唯一事实源）。
 *
 * - 19 个必需键
 * - judge 启用时的额外 2 个键
 * - 邮件分支的额外键
 * - 取值约束 STORAGE_PROVIDER / JWT_SECRET / APP_URL / NOJ_VERSION
 * - 占位值判定
 * - `JUDGE_ENABLED` 的真值集合
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
 * 19 个必需键（顺序即报错顺序）。
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

/** `JUDGE_ENABLED` 为真时额外必需的键。 */
export const JUDGE_KEYS: readonly string[] = [
    "JUDGE_DOCKER_SOCKET",
    "JUDGE_DOCKER_SOCKET_GID",
];

/** `JUDGE_ENABLED` 判定为假的值。 */
const JUDGE_FALSY: ReadonlySet<string> = new Set([
    "false",
    "FALSE",
    "no",
    "NO",
    "0",
    "off",
    "OFF",
]);

/** `JUDGE_ENABLED` 判定为真的值；空串表示未设置。 */
const JUDGE_TRUTHY: ReadonlySet<string> = new Set([
    "",
    "true",
    "TRUE",
    "yes",
    "YES",
    "1",
    "on",
    "ON",
]);

/**
 * 校验 JUDGE_ENABLED 是否为受支持取值；非法值返回错误信息，合法值返回 null。
 *
 * 取值集合：
 * - 假值集合 `false|FALSE|no|NO|0|off|OFF` → 关闭，合法；
 * - 真值集合 `""|true|TRUE|yes|YES|1|on|ON` → 启用，合法（空串/undefined 表示未设置）；
 * - 其余任意值 → 返回错误信息。
 */
export function judgeEnabledError(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    return JUDGE_FALSY.has(raw) || JUDGE_TRUTHY.has(raw)
        ? null
        : "JUDGE_ENABLED 必须是 true 或 false";
}

/**
 * 判断 judge 是否启用。
 *
 * 注意**空/未设置**视为启用，因此缺省要求 judge 键。
 * 枚举外的非法值须由调用方先用 {@link judgeEnabledError} 拒绝；本函数对非法值
 * 按「启用」兜底（fail-safe），使非法值不会静默跳过 judge 键要求。
 */
function judgeEnabled(env: Record<string, string>): boolean {
    const raw = env["JUDGE_ENABLED"] ?? "";
    return !JUDGE_FALSY.has(raw);
}

/**
 * 占位值 / 未配置判定。
 *
 * 语义要点：
 * - 空串或 undefined → true；
 * - 区分大小写；
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
 * 校验必需键。
 *
 * 返回两个互斥集合：
 * - `missing`：键缺失或为空串（未配置）；
 * - `placeholder`：键有值但命中占位值黑名单。
 *
 * `JUDGE_ENABLED` 为真时，额外要求 {@link JUDGE_KEYS}。
 *
 * 注意返回形状只有 `{ missing, placeholder }`，无法表达枚举错误：
 * **调用方必须先调用 {@link judgeEnabledError} 校验 `JUDGE_ENABLED`**，
 * 非法值（如 `maybe`）应先报错返回，再进入本函数。
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

// ---------------- 条件键（EMAIL_PROVIDER 分支） ----------------

/** `EMAIL_PROVIDER` 的受支持取值。 */
export const EMAIL_PROVIDERS: readonly string[] = [
    "aliyun",
    "tencent",
    "disabled",
];

/** `EMAIL_PROVIDER=aliyun` 时额外必需的键。 */
export const ALIYUN_EMAIL_KEYS: readonly string[] = [
    "ALIBABA_ACCESS_KEY_ID",
    "ALIBABA_ACCESS_KEY_SECRET",
    "ALIBABA_FROM_EMAIL",
];

/** `EMAIL_PROVIDER=tencent` 时额外必需的键。 */
export const TENCENT_EMAIL_KEYS: readonly string[] = [
    "TENCENT_SECRET_ID",
    "TENCENT_SECRET_KEY",
    "TENCENT_FROM_EMAIL",
    "TENCENT_REGION",
];

/** 由 `EMAIL_PROVIDER` 决定的额外必需键（枚举外返回空数组，错误另报）。 */
export function emailBranchKeys(
    provider: string | undefined,
): readonly string[] {
    switch (provider) {
        case "aliyun":
            return ALIYUN_EMAIL_KEYS;
        case "tencent":
            return TENCENT_EMAIL_KEYS;
        default:
            return [];
    }
}

// ---------------- 取值约束 ----------------

/** 单个键的取值约束。 */
export interface EnvValueRule {
    /** 约束的目标键。 */
    key: string;
    /**
     * 判定：返回错误文案（不含 "  - " 前缀）表示不合规，返回 null 表示通过。
     * `value` 是键的原始值；未设置/空值由调用方先行处理，不进入本判定。
     */
    check(env: Record<string, string>, value: string): string | null;
}

/**
 * 取值约束：
 * - STORAGE_PROVIDER 必须恰为 s3；
 * - JWT_SECRET 不得含子串 test；
 * - APP_URL 必须 http:// 或 https:// 开头，
 *   且 http:// 时必须显式 NOJ_ALLOW_INSECURE_HTTP=true；
 * - NOJ_VERSION 必须匹配 Release 标签正则。
 *
 * 规则相互独立，同一键可挂多条；数组顺序即报错顺序
 * （STORAGE → JWT → APP_URL → VERSION）。
 *
 * **不含 GID 规则**：GID 数字校验仅在 judge 启用时生效，且其错误计入
 * `missing`，与本节"仅已配置键取值约束"语义不同；
 * 由 `prod/config.ts:checkRequiredValues` 的 judge 分支单独实现。
 */
export const ENV_VALUE_RULES: readonly EnvValueRule[] = [
    {
        key: "STORAGE_PROVIDER",
        check: (_env, value) =>
            value === "s3" ? null : "STORAGE_PROVIDER 必须设置为 s3",
    },
    {
        key: "JWT_SECRET",
        check: (_env, value) =>
            value.includes("test") ? "JWT_SECRET 不得使用测试密钥" : null,
    },
    {
        key: "APP_URL",
        check: (env, value) => {
            if (
                value.startsWith("http://") &&
                env["NOJ_ALLOW_INSECURE_HTTP"] !== "true"
            ) {
                return "网站完整网址使用 HTTP 时，必须明确选择临时 HTTP 模式";
            }
            return null;
        },
    },
    {
        key: "APP_URL",
        check: (_env, value) =>
            value.startsWith("http://") || value.startsWith("https://")
                ? null
                : "网站完整网址必须以 http:// 或 https:// 开头",
    },
    {
        key: "NOJ_VERSION",
        check: (_env, value) =>
            /^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(value)
                ? null
                : "NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.1.1-rc.1）",
    },
];

/**
 * 配置文件的权限约束。
 *
 * - 权限**读不出来** → 硬错误；
 * - 权限读出来了但不是 600/400 → 硬错误。
 */
export type FilePermissionVerdict =
    | { kind: "ok"; mode: string }
    | { kind: "error"; mode: string; message: string }
    | { kind: "unreadable"; message: string };

/** 生产配置文件的合法权限。 */
export const ENV_FILE_ALLOWED_MODES: readonly string[] = ["600", "400"];

/**
 * 校验 .env.prod 的权限是否为 600 或 400。
 *
 * @param mode probe 读到的八进制权限串；读不出时传 null。
 */
export function checkEnvFileMode(
    mode: string | null,
    envFile: string,
): FilePermissionVerdict {
    if (mode === null) {
        return {
            kind: "unreadable",
            message: "无法读取生产配置文件权限：" + envFile,
        };
    }
    if (!ENV_FILE_ALLOWED_MODES.includes(mode)) {
        return {
            kind: "error",
            mode,
            message: "生产配置文件权限必须为 600 或 400：" + envFile,
        };
    }
    return { kind: "ok", mode };
}
