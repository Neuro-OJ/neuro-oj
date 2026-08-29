/**
 * .env 占位符自检。
 *
 * 目的：拦截 .env 中残留 .env.example 占位值的常见事故。
 * 例如开发者在 CI 或容器里 `cp .env.example .env` 后忘记修改
 * `JWT_SECRET=change-this-...`，导致 main.ts 启动时硬拒绝但要等
 * 一段时间才看到真实错误信息。
 *
 * 用法（在 noj-core 目录）：
 *     deno task check:env                         # 检查 .env
 *     deno task check:env --strict                # CI 模式，任何占位值都 exit 1
 *     deno task check:env --strict --production --file ../.env.prod
 *
 * 检查项：
 *   1. .env 文件存在
 *   2. JWT_SECRET 长度 ≥ 32（与 main.ts MIN_JWT_SECRET_LENGTH 一致）
 *   3. TFA_ENCRYPTION_KEY 长度 ≥ 32（TOTP secret 加密要求）
 *   4. 关键字段不含已知占位符（change-this-...、changeme、example、test、xxx、placeholder）
 *
 * 行为：
 *   - 缺省模式（--strict 缺失）：仅打印警告，不阻塞
 *   - --strict 模式：发现任一占位值即 exit 1
 *   - --production 模式：额外检查生产必填项和 secret 文件权限
 *
 * 与 seed.ts 解耦：本脚本独立运行，**不依赖** PG/Redis，
 * 也不被 seed.ts 调用——避免与正在进行的 PR #69 撞 scripts/seed.ts。
 * 后续可在 PR #69 合并后把本脚本接入 seed.ts 早期校验。
 */

import { MIN_JWT_SECRET_LENGTH } from "../src/lib/constants.ts";
import { MIN_TFA_ENCRYPTION_KEY_LENGTH } from "../src/lib/constants.ts";

// 已知占位值黑名单（不区分大小写）。命中即视为未配置。
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^change-?this/i,
  /^change-?me/i,
  /^changeme$/i,
  /^example$/i,
  /^test$/i,
  /^xxx+$/i,
  /^placeholder/i,
  /your[-_]?(secret|password|key)/i,
  /replace-?me/i,
  /TODO/i,
  // 审计 NOJ-131：仓库历史模板中公开过的默认管理员凭据
  /^admin@noj\.local$/i,
  /^AdminPass123!$/i,
];

const STRICT_FLAG = "--strict";
const PRODUCTION_FLAG = "--production";

/** 从 key=value 文件读取。注释行（# 开头）和空行跳过。 */
function parseEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return map;
    throw err;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉行内 # 注释
    const hashIdx = value.indexOf(" #");
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    // 去掉首尾引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

interface Finding {
  key: string;
  display: string;
  reason: string;
}

function inspect(env: Map<string, string>): Finding[] {
  const findings: Finding[] = [];

  for (const [key, value] of env) {
    // 跳过空值：主流程会另行校验
    if (!value) continue;

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({
          key,
          display: "[已隐藏]",
          reason: `命中占位符模式 ${pattern}`,
        });
        break;
      }
    }
  }

  // 专项：JWT_SECRET 长度（与 main.ts MIN_JWT_SECRET_LENGTH 对齐）
  const jwt = env.get("JWT_SECRET");
  if (jwt && jwt.length < MIN_JWT_SECRET_LENGTH) {
    findings.push({
      key: "JWT_SECRET",
      display: `${jwt.length} 字符`,
      reason: "HS256 要求 ≥ 32 字符",
    });
  }

  // 专项：TFA_ENCRYPTION_KEY 必填 + 长度（TOTP secret 加密要求）
  // 与 JWT_SECRET 不同，该密钥缺失时 main.ts 会 fail-fast 拒绝启动
  // （评审 P2 修复），check-env 需要提前暴露，避免开发者到启动时才看到。
  const tfaKey = env.get("TFA_ENCRYPTION_KEY");
  if (!tfaKey || tfaKey.length < MIN_TFA_ENCRYPTION_KEY_LENGTH) {
    findings.push({
      key: "TFA_ENCRYPTION_KEY",
      display: tfaKey ? `${tfaKey.length} 字符` : "(缺失)",
      reason: tfaKey
        ? "TOTP secret 加密要求 ≥ 32 字符"
        : "TOTP secret 加密密钥为必填项，缺失将导致 noj-core 拒绝启动",
    });
  }

  const githubKeys = ["OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET"];
  if (githubKeys.some((key) => env.has(key) && env.get(key)?.trim())) {
    for (const key of githubKeys) {
      if (!env.get(key)?.trim()) {
        findings.push({
          key,
          display: "(缺失)",
          reason: "GitHub OAuth 配置必须同时提供 client id 和 secret",
        });
      }
    }
  }
  const oidcKeys = [
    "OAUTH_OIDC_ISSUER_URL",
    "OAUTH_OIDC_CLIENT_ID",
    "OAUTH_OIDC_CLIENT_SECRET",
  ];
  if (oidcKeys.some((key) => env.has(key) && env.get(key)?.trim())) {
    for (const key of oidcKeys) {
      if (!env.get(key)?.trim()) {
        findings.push({
          key,
          display: "(缺失)",
          reason: "OIDC 配置必须同时提供 issuer、client id 和 secret",
        });
      }
    }
  }

  return findings;
}

function inspectProduction(
  env: Map<string, string>,
  envPath: string,
): Finding[] {
  const findings: Finding[] = [];
  const required = [
    "NOJ_VERSION",
    "APP_URL",
    "CORS_ALLOWED_ORIGINS",
    "TRUSTED_PROXIES",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "JWT_SECRET",
    "TFA_ENCRYPTION_KEY",
    "EMAIL_PROVIDER",
    "STORAGE_PROVIDER",
  ];

  for (const key of required) {
    if (!env.get(key)?.trim()) {
      findings.push({ key, display: "(缺失)", reason: "生产配置必填" });
    }
  }

  const emailProvider = env.get("EMAIL_PROVIDER");
  const emailKeys = emailProvider === "aliyun"
    ? [
      "ALIBABA_ACCESS_KEY_ID",
      "ALIBABA_ACCESS_KEY_SECRET",
      "ALIBABA_FROM_EMAIL",
    ]
    : emailProvider === "tencent"
    ? [
      "TENCENT_SECRET_ID",
      "TENCENT_SECRET_KEY",
      "TENCENT_FROM_EMAIL",
      "TENCENT_REGION",
    ]
    : [];
  if (emailProvider !== "aliyun" && emailProvider !== "tencent") {
    findings.push({
      key: "EMAIL_PROVIDER",
      display: "[已隐藏]",
      reason: "生产环境只能使用 aliyun、tencent 或 disabled",
    });
  }
  for (const key of emailKeys) {
    if (!env.get(key)?.trim()) {
      findings.push({
        key,
        display: "(缺失)",
        reason: "所选邮件 Provider 必填",
      });
    }
  }

  if (env.get("STORAGE_PROVIDER") !== "s3") {
    findings.push({
      key: "STORAGE_PROVIDER",
      display: "[已隐藏]",
      reason: "生产环境必须使用 s3",
    });
  }

  try {
    const mode = Deno.statSync(envPath).mode;
    if (mode !== null && (mode & 0o077) !== 0) {
      findings.push({
        key: "secret 文件权限",
        display: "[已隐藏]",
        reason: "生产 secret 文件必须限制为属主可读写（建议 chmod 600）",
      });
    }
  } catch {
    // 文件路径由 main() 传入；这里无法访问时不重复报告文件不存在。
  }

  return findings;
}

function getFilePath(): string {
  const inline = Deno.args.find((arg) => arg.startsWith("--file="));
  if (inline) return inline.slice("--file=".length);
  const index = Deno.args.indexOf("--file");
  if (index >= 0 && Deno.args[index + 1]) return Deno.args[index + 1];
  return ".env";
}

function main(): void {
  const strict = Deno.args.includes(STRICT_FLAG);
  const production = Deno.args.includes(PRODUCTION_FLAG);
  const envPath = getFilePath();
  const env = parseEnvFile(envPath);

  if (env.size === 0) {
    console.error(`[check-env] ❌ 找不到 ${envPath}`);
    console.error(`[check-env] 请先执行: cp .env.example .env`);
    if (strict) Deno.exit(1);
    return;
  }

  const findings = [
    ...inspect(env),
    ...(production ? inspectProduction(env, envPath) : []),
  ];

  if (findings.length === 0) {
    console.log(
      `[check-env] ✅ ${envPath} 通过检查（${env.size} 个键，0 个占位值）`,
    );
    return;
  }

  console.warn(`[check-env] ⚠️  发现 ${findings.length} 个可疑值：\n`);
  for (const f of findings) {
    console.warn(`  • ${f.key} = ${f.display}`);
    console.warn(`    原因: ${f.reason}`);
  }
  console.warn("");
  console.warn("[check-env] 修复方法：");
  console.warn("  1. 打开 .env，把上述字段改为真实值");
  console.warn("  2. 重新运行此脚本验证");
  console.warn("");

  if (strict) {
    console.error("[check-env] --strict 模式下视为失败，exit 1");
    Deno.exit(1);
  }
}

main();
