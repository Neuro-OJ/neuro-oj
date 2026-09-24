import { assertEquals } from "@std/assert";
import {
  ALIYUN_EMAIL_KEYS,
  checkEnvFileMode,
  EMAIL_PROVIDERS,
  emailBranchKeys,
  ENV_KEYS,
  ENV_VALUE_RULES,
  isPlaceholder,
  JUDGE_KEYS,
  judgeEnabledError,
  TENCENT_EMAIL_KEYS,
  validateEnv,
} from "./config-schema.ts";

/**
 * 键清单的权威来源是 bash `scripts/deploy/deploy.sh:686-692` 的 `check_required_values`。
 */
const BASH_REQUIRED_KEYS = [
  "NOJ_VERSION",
  "DOMAIN",
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
  "STORAGE_PROVIDER",
  "JWT_SECRET",
  "TFA_ENCRYPTION_KEY",
  "NOJ_LLM_SERVICE_TOKEN",
  "NOJ_LLM_STORE_KEY",
  "EMAIL_PROVIDER",
] as const;

Deno.test("ENV_KEYS 覆盖 bash 硬编码的 19 个键", () => {
  const names = ENV_KEYS.map((k) => k.key);
  for (
    const k of [
      "NOJ_VERSION",
      "DOMAIN",
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
      "STORAGE_PROVIDER",
      "JWT_SECRET",
      "TFA_ENCRYPTION_KEY",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_STORE_KEY",
      "EMAIL_PROVIDER",
    ]
  ) {
    assertEquals(names.includes(k), true, "缺少键: " + k);
  }
});

Deno.test("ENV_KEYS 与 bash 清单逐字一致（无多无少、无重复）", () => {
  const names = ENV_KEYS.map((k) => k.key);
  assertEquals([...names].sort(), [...BASH_REQUIRED_KEYS].sort());
  assertEquals(new Set(names).size, names.length, "ENV_KEYS 存在重复键");
  assertEquals(ENV_KEYS.length, 19);
  // judge 条件键不在无条件必需清单中
  for (const k of JUDGE_KEYS) {
    assertEquals(
      names.includes(k),
      false,
      "judge 条件键不应出现在 ENV_KEYS: " + k,
    );
  }
});

Deno.test("ENV_KEYS 全部标记 required 且敏感键带 secret", () => {
  for (const spec of ENV_KEYS) {
    assertEquals(spec.required, true, spec.key + " 应为必需");
  }
  const secretKeys = ENV_KEYS.filter((s) => s.secret).map((s) => s.key);
  for (
    const k of [
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MINIO_ROOT_PASSWORD",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "JWT_SECRET",
      "TFA_ENCRYPTION_KEY",
      "NOJ_LLM_SERVICE_TOKEN",
      "NOJ_LLM_STORE_KEY",
    ]
  ) {
    assertEquals(secretKeys.includes(k), true, "缺少 secret 标记: " + k);
  }
  for (const k of ["DOMAIN", "APP_URL", "EMAIL_PROVIDER"]) {
    assertEquals(
      secretKeys.includes(k),
      false,
      "非敏感键不应标记 secret: " + k,
    );
  }
});

Deno.test("isPlaceholder 识别空值与占位值", () => {
  assertEquals(isPlaceholder(undefined), true);
  assertEquals(isPlaceholder(""), true);
  assertEquals(isPlaceholder("change-this-in-production"), true);
  assertEquals(isPlaceholder("your-domain.example.com"), true);
  // bash `is_placeholder` 的 `*example*` 是子串匹配，`real.example.com` 命中；
  // 这与 brief 提供的断言相反，以 bash（本任务权威来源）为准，详情见 task-2-report.md。
  assertEquals(isPlaceholder("real.example.com"), true);
});

Deno.test("isPlaceholder 逐字对照 bash is_placeholder 的 case 模式", () => {
  // 子串模式（deploy.sh:671）
  for (
    const v of [
      "change-me",
      "x-change-me-x",
      "prefix-change-this",
      "changeme",
      "foo-example-bar",
      "placeholder-x",
      "my-placeholder",
      "replace-me-now",
      "your-key",
      "your-domain.example.com",
    ]
  ) {
    assertEquals(isPlaceholder(v), true, "应判为占位值: " + v);
  }
  // 整体匹配 test / xxx*；不区分大小写不存在（bash case 区分大小写）
  assertEquals(isPlaceholder("test"), true);
  assertEquals(isPlaceholder("testing"), false);
  assertEquals(isPlaceholder("TEST"), false);
  assertEquals(isPlaceholder("Testing"), false);
  assertEquals(isPlaceholder("xxx"), true);
  assertEquals(isPlaceholder("xxxval"), true);
  assertEquals(isPlaceholder("vxx"), false);
  // 合法生产值不应误判
  for (
    const v of [
      "oj.neuro-oj.com",
      "https://noj.neuro-oj.com",
      "172.28.0.0/16",
      "s3",
      "disabled",
    ]
  ) {
    assertEquals(isPlaceholder(v), false, "不应判为占位值: " + v);
  }
});

Deno.test("validateEnv 报告缺失与占位", () => {
  const r = validateEnv({ DOMAIN: "", APP_URL: "https://real.example.com" });
  assertEquals(r.missing.includes("DOMAIN"), true);
  assertEquals(r.missing.includes("APP_URL"), false);
});

Deno.test("validateEnv 区分 missing 与 placeholder，且判定基于 bash is_placeholder", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["DOMAIN"] = "";
  env["JWT_SECRET"] = "change-me-please";
  env["JUDGE_ENABLED"] = "false";
  const r = validateEnv(env);
  assertEquals(r.missing, ["DOMAIN"]);
  assertEquals(r.placeholder, ["JWT_SECRET"]);
  // JUDGE_ENABLED=false → 不要求 judge 键
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), false);
});

Deno.test("validateEnv 无缺失无占位时返回空集合", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["JUDGE_ENABLED"] = "false";
  const r = validateEnv(env);
  assertEquals(r.missing, []);
  assertEquals(r.placeholder, []);
});

Deno.test("judge 启用时额外要求 JUDGE_DOCKER_SOCKET 与 GID", () => {
  const r = validateEnv({ JUDGE_ENABLED: "true" });
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), true);
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET_GID"), true);
});

Deno.test("judge 真值集合与 bash judge_enabled 一致", () => {
  // 真：空串（未设置）/ true / TRUE / yes / YES / 1 / on / ON
  for (const v of ["", "true", "TRUE", "yes", "YES", "1", "on", "ON"]) {
    const r = validateEnv({ JUDGE_ENABLED: v });
    assertEquals(
      r.missing.includes("JUDGE_DOCKER_SOCKET"),
      true,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应视为启用",
    );
  }
  // 假：false / FALSE / no / NO / 0 / off / OFF
  for (const v of ["false", "FALSE", "no", "NO", "0", "off", "OFF"]) {
    const r = validateEnv({ JUDGE_ENABLED: v });
    assertEquals(
      r.missing.includes("JUDGE_DOCKER_SOCKET"),
      false,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应视为关闭",
    );
  }
});

Deno.test("judge 启用时已配置的 judge 键不再报告缺失", () => {
  const env: Record<string, string> = {};
  for (const k of BASH_REQUIRED_KEYS) env[k] = "real-value";
  env["JUDGE_ENABLED"] = "true";
  env["JUDGE_DOCKER_SOCKET"] = "/run/noj-judge/docker.sock";
  env["JUDGE_DOCKER_SOCKET_GID"] = "10001";
  const r = validateEnv(env);
  assertEquals(r.missing, []);
  assertEquals(r.placeholder, []);
});
Deno.test("judgeEnabledError 对全部假值返回 null（视为关闭）", () => {
  // deploy.sh:678 的假值集合
  for (const v of ["false", "FALSE", "no", "NO", "0", "off", "OFF"]) {
    assertEquals(
      judgeEnabledError(v),
      null,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应合法（关闭）",
    );
  }
});

Deno.test("judgeEnabledError 对全部真值返回 null（含空串与 undefined）", () => {
  // deploy.sh:679 的真值集合：空串（含未设置）视为启用
  for (
    const v of [
      "",
      undefined,
      "true",
      "TRUE",
      "yes",
      "YES",
      "1",
      "on",
      "ON",
    ]
  ) {
    assertEquals(
      judgeEnabledError(v),
      null,
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应合法（启用）",
    );
  }
});

Deno.test("judgeEnabledError 对枚举外的值报告 bash 同款错误", () => {
  // bash judge_enabled 的星号通配分支会 fail；TS 必须同样报错而非静默接受
  for (const v of ["maybe", "2", "True", "tru", "enabled", " ", "00"]) {
    assertEquals(
      judgeEnabledError(v),
      "JUDGE_ENABLED 必须是 true 或 false",
      "JUDGE_ENABLED=" + JSON.stringify(v) + " 应报告非法值",
    );
  }
});

Deno.test("validateEnv 不承载 JUDGE_ENABLED 枚举错误（调用方须先查 judgeEnabledError）", () => {
  // 返回形状只有 { missing, placeholder }，无法表达枚举错误；
  // 非法值下 validateEnv 的 judge 分支以「启用」兜底，枚举错误由调用方单独校验。
  const r = validateEnv({ JUDGE_ENABLED: "maybe" });
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), true);
  assertEquals(
    judgeEnabledError("maybe"),
    "JUDGE_ENABLED 必须是 true 或 false",
  );
});
// ---------------- 条件键与取值约束（T11 R3 补齐） ----------------

Deno.test("EMAIL_PROVIDERS 与 bash case 分支逐字一致", () => {
  assertEquals([...EMAIL_PROVIDERS], ["aliyun", "tencent", "disabled"]);
  assertEquals([...emailBranchKeys("aliyun")], [...ALIYUN_EMAIL_KEYS]);
  assertEquals([...emailBranchKeys("tencent")], [...TENCENT_EMAIL_KEYS]);
  // disabled 与枚举外均无额外键（枚举错误由调用方另行报告）。
  assertEquals(emailBranchKeys("disabled"), []);
  assertEquals(emailBranchKeys("smtp"), []);
  assertEquals(emailBranchKeys(undefined), []);
});

Deno.test("ENV_VALUE_RULES 逐条对照 bash :739-764", () => {
  // 同一键可挂多条规则（bash 是独立 if），故按"收集全部命中"的方式应用。
  const apply = (
    env: Record<string, string>,
    key: string,
    value: string,
  ): string[] =>
    ENV_VALUE_RULES
      .filter((rule) => rule.key === key)
      .map((rule) => rule.check(env, value))
      .filter((error): error is string => error !== null);

  // STORAGE_PROVIDER 必须恰为 s3。
  assertEquals(apply({}, "STORAGE_PROVIDER", "s3"), []);
  assertEquals(apply({}, "STORAGE_PROVIDER", "minio"), [
    "STORAGE_PROVIDER 必须设置为 s3",
  ]);
  // JWT_SECRET 不得含 test（大小写敏感子串）。
  assertEquals(apply({}, "JWT_SECRET", "a-test-b"), [
    "JWT_SECRET 不得使用测试密钥",
  ]);
  assertEquals(apply({}, "JWT_SECRET", "TEST"), []);
  // APP_URL 协议与不安全 HTTP 模式。
  assertEquals(apply({}, "APP_URL", "https://x.test"), []);
  assertEquals(apply({}, "APP_URL", "ftp://x.test"), [
    "网站完整网址必须以 http:// 或 https:// 开头",
  ]);
  assertEquals(
    apply({ NOJ_ALLOW_INSECURE_HTTP: "false" }, "APP_URL", "http://x.test"),
    ["网站完整网址使用 HTTP 时，必须明确选择临时 HTTP 模式"],
  );
  assertEquals(
    apply({ NOJ_ALLOW_INSECURE_HTTP: "true" }, "APP_URL", "http://x.test"),
    [],
  );
  // NOJ_VERSION Release 标签。
  assertEquals(apply({}, "NOJ_VERSION", "v0.1.0"), []);
  assertEquals(apply({}, "NOJ_VERSION", "0.1.1-rc.1"), []);
  assertEquals(apply({}, "NOJ_VERSION", "latest"), [
    "NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.1.1-rc.1）",
  ]);
  // GID 不在通用规则表（judge 分支单独处理）。
  assertEquals(
    ENV_VALUE_RULES.some((rule) => rule.key === "JUDGE_DOCKER_SOCKET_GID"),
    false,
  );
});

Deno.test("checkEnvFileMode: 三态与 bash check_file_permissions 一致", () => {
  assertEquals(checkEnvFileMode("600", "/x/.env.prod"), {
    kind: "ok",
    mode: "600",
  });
  assertEquals(checkEnvFileMode("400", "/x/.env.prod"), {
    kind: "ok",
    mode: "400",
  });
  assertEquals(checkEnvFileMode("640", "/x/.env.prod"), {
    kind: "error",
    mode: "640",
    message: "生产配置文件权限必须为 600 或 400：/x/.env.prod",
  });
  assertEquals(checkEnvFileMode(null, "/x/.env.prod"), {
    kind: "unreadable",
    message: "无法读取生产配置文件权限：/x/.env.prod",
  });
});
