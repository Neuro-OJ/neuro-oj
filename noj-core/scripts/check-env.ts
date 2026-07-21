/**
 * .env 占位符自检。
 *
 * 目的：拦截 .env 中残留 .env.example 占位值的常见事故。
 * 例如开发者在 CI 或容器里 `cp .env.example .env` 后忘记修改
 * `JWT_SECRET=change-this-...`，导致 main.ts 启动时硬拒绝但要等
 * 一段时间才看到真实错误信息。
 *
 * 用法（在 noj-core 目录）：
 *     deno task check:env          # 检查 .env
 *     deno task check:env --strict # CI 模式，任何占位值都 exit 1
 *
 * 检查项：
 *   1. .env 文件存在
 *   2. JWT_SECRET 长度 ≥ 32（与 main.ts MIN_JWT_SECRET_LENGTH 一致）
 *   3. 关键字段不含已知占位符（change-this-...、changeme、example、test、xxx、placeholder）
 *
 * 行为：
 *   - 缺省模式（--strict 缺失）：仅打印警告，不阻塞
 *   - --strict 模式：发现任一占位值即 exit 1
 *
 * 与 seed.ts 解耦：本脚本独立运行，**不依赖** PG/Redis，
 * 也不被 seed.ts 调用——避免与正在进行的 PR #69 撞 scripts/seed.ts。
 * 后续可在 PR #69 合并后把本脚本接入 seed.ts 早期校验。
 */

// 已知占位值黑名单（不区分大小写）。命中即视为未配置。
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^change-?this/i,
  /^changeme$/i,
  /^example$/i,
  /^test$/i,
  /^xxx+$/i,
  /^placeholder/i,
  /your[-_]?(secret|password|key)/i,
  /replace-?me/i,
  /TODO/i,
];

const STRICT_FLAG = "--strict";

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
  value: string;
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
          value,
          reason: `命中占位符模式 ${pattern}`,
        });
        break;
      }
    }
  }

  // 专项：JWT_SECRET 长度（与 main.ts MIN_JWT_SECRET_LENGTH 对齐）
  const jwt = env.get("JWT_SECRET");
  if (jwt && jwt.length < 32) {
    findings.push({
      key: "JWT_SECRET",
      value: `${jwt.length} 字符`,
      reason: "HS256 要求 ≥ 32 字符",
    });
  }

  return findings;
}

function main(): void {
  const strict = Deno.args.includes(STRICT_FLAG);
  const envPath = ".env";
  const env = parseEnvFile(envPath);

  if (env.size === 0) {
    console.error(`[check-env] ❌ 找不到 ${envPath}`);
    console.error(`[check-env] 请先执行: cp .env.example .env`);
    if (strict) Deno.exit(1);
    return;
  }

  const findings = inspect(env);

  if (findings.length === 0) {
    console.log(
      `[check-env] ✅ ${envPath} 通过检查（${env.size} 个键，0 个占位值）`,
    );
    return;
  }

  console.warn(`[check-env] ⚠️  发现 ${findings.length} 个可疑值：\n`);
  for (const f of findings) {
    const preview = f.value.length > 60
      ? `${f.value.slice(0, 57)}...`
      : f.value;
    console.warn(`  • ${f.key} = ${preview}`);
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
