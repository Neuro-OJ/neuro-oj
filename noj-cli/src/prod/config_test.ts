/**
 * prod/config 测试：全部注入 IO / runner / isTty，绝不执行 cosign、docker
 * 或真实交互，也不写 /etc。
 *
 * 断言逐条对照 scripts/deploy/deploy.sh（R3）：
 * - check_required_values :684-766（含 judge 分支 :702/:747、站点地址 :713）
 * - check_judge_socket :768、check_port_value :780、is_site_address :354
 * - detect_panel :791、show_panel_guidance :804
 * - verify_image_signatures :837-874、record_deployment_metadata :875-891
 * - passphrase_file_mode :916、ensure_backup_passphrase :920-953
 * - configure_env_interactive :429-595
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ALIYUN_EMAIL_KEYS,
  checkEnvFileMode,
  EMAIL_PROVIDERS,
  ENV_VALUE_RULES,
  TENCENT_EMAIL_KEYS,
} from "../core/config-schema.ts";
import { readEnvFile } from "../core/env-file.ts";
import type { CommandRunner, SpawnHandle } from "../runtime/command.ts";
import type { PromptIO } from "../tui/io.ts";
import {
  backupPassphrasePath,
  checkJudgeSocket,
  checkPortValue,
  checkRequiredValues,
  DEFAULT_BACKUP_PASSPHRASE_FILE,
  DEFAULT_COSIGN_IDENTITY_REGEX,
  DEFAULT_PANEL_COMMAND,
  DEFAULT_PANEL_ROOT,
  detectPanel,
  ensureBackupPassphrase,
  type EnvValues,
  generateSecret,
  isIpv4Address,
  isSiteAddress,
  PANEL_GUIDANCE_OK_LINE,
  panelGuidance,
  passphraseFileMode,
  recordDeploymentMetadata,
  runConfigWizard,
  showPanelGuidance,
  verifyImageSignatures,
  wizardNeedsInteractiveInput,
} from "./config.ts";

// ---------------- 测试基建 ----------------

/** 可编程 fake IO：按序消费 answers；分别记录 write 与 prompt（含秘密输入）。 */
class FakeIO implements PromptIO {
  writes: string[] = [];
  prompts: string[] = [];
  lineReads = 0;
  secretReads = 0;
  answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  write(text: string): void {
    this.writes.push(text);
  }
  readLine(prompt: string): Promise<string> {
    this.lineReads++;
    this.prompts.push(prompt);
    return Promise.resolve(this.answers.shift() ?? "");
  }
  readSecret(prompt: string): Promise<string> {
    this.secretReads++;
    this.prompts.push(prompt);
    return Promise.resolve(this.answers.shift() ?? "");
  }
  /** 全部 write 输出拼接（敏感值断言用）。 */
  output(): string {
    return this.writes.join("");
  }
}

/** 记录命令调用形状的 fake runner；按 opts 决定 digest 与 cosign 成败。 */
function recordingRunner(
  calls: string[][],
  opts: { digests?: Record<string, string>; failures?: Set<string> } = {},
): CommandRunner {
  return {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd === "cosign") {
        const failed = opts.failures?.has(args[args.length - 1] ?? "");
        return Promise.resolve({
          code: failed ? 1 : 0,
          stdout: "",
          stderr: failed ? "signature mismatch" : "",
        });
      }
      if (cmd === "docker" && args.includes("imagetools")) {
        const image = args[args.length - 1] ?? "";
        const name = image.slice(0, image.lastIndexOf(":"));
        const digest = opts.digests?.[name];
        if (digest === undefined) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
        }
        return Promise.resolve({
          code: 0,
          stdout: `Name: ${image}\nDigest: ${digest}\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(_opts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

/** 一份可通过必填校验的完整 .env.prod 值（judge 默认关闭以简化断言语境）。 */
function okEnv(overrides: EnvValues = {}): EnvValues {
  return {
    NOJ_VERSION: "v0.9.5",
    DOMAIN: "oj.beta.test",
    APP_URL: "https://oj.beta.test",
    CORS_ALLOWED_ORIGINS: "https://oj.beta.test",
    TRUSTED_PROXIES: "172.28.0.0/16",
    POSTGRES_PASSWORD: "pg-pass-0001",
    REDIS_PASSWORD: "redis-pass-0001",
    MINIO_ROOT_USER: "nojminio0001",
    MINIO_ROOT_PASSWORD: "minio-pass-0001",
    S3_ACCESS_KEY: "nojs30001",
    S3_SECRET_KEY: "s3-secret-0001",
    S3_BUCKET: "noj-support-packages",
    S3_ENDPOINT: "http://minio:9000",
    STORAGE_PROVIDER: "s3",
    JWT_SECRET: "jwt-secret-0001",
    TFA_ENCRYPTION_KEY: "tfa-secret-0001",
    NOJ_LLM_SERVICE_TOKEN: "llm-token-0001",
    NOJ_LLM_STORE_KEY: "llm-store-0001",
    EMAIL_PROVIDER: "disabled",
    NOJ_ENFORCE_IMAGE_SIGNATURES: "false",
    JUDGE_ENABLED: "false",
    ...overrides,
  };
}

const DIGEST = (n: number): string =>
  `sha256:${n.toString(16).padStart(64, "0")}`;

/** 六个生产镜像的 digest 表。 */
function imageDigests(registry: string): Record<string, string> {
  return {
    [`${registry}/noj-server`]: DIGEST(1),
    [`${registry}/noj-ui`]: DIGEST(2),
    [`${registry}/noj-llm-gateway`]: DIGEST(3),
    [`${registry}/noj-judge`]: DIGEST(4),
    [`${registry}/noj-evaluator-python`]: DIGEST(5),
    [`${registry}/noj-solution-python`]: DIGEST(6),
  };
}

// ---------------- 必填校验 ----------------

Deno.test("checkRequiredValues: 缺失键进 missing，占位键进 placeholder", async () => {
  const env: EnvValues = {
    ...okEnv(),
    DOMAIN: "",
    JWT_SECRET: "change-me-please",
  };
  const report = await checkRequiredValues(env);
  assertEquals(report.judgeError, null);
  assertEquals(report.missing, ["DOMAIN"]);
  assertEquals(report.placeholder, ["JWT_SECRET"]);
  assertEquals(report.ok, false);
});

Deno.test("checkRequiredValues: 未设置（undefined）也计入 missing", async () => {
  const env = okEnv();
  delete env.S3_BUCKET;
  const report = await checkRequiredValues(env);
  assertEquals(report.missing, ["S3_BUCKET"]);
  assertEquals(report.placeholder, []);
  assertEquals(report.ok, false);
});

Deno.test("checkRequiredValues: 全部合法时 ok 且无 missing/placeholder", async () => {
  const report = await checkRequiredValues(okEnv());
  assertEquals(report.ok, true);
  assertEquals(report.missing, []);
  assertEquals(report.placeholder, []);
  assertEquals(report.errors, []);
  assertEquals(report.siteAddressError, null);
});

// ---------------- judge 枚举（T2 carry-forward） ----------------

Deno.test("checkRequiredValues: JUDGE_ENABLED=maybe 在 validateEnv 之前报错", async () => {
  // 故意只给一个非法 JUDGE_ENABLED 与一堆缺失键：只有枚举错误能被报出，
  // 证明 judgeEnabledError 先于 validateEnv。
  const env: EnvValues = { JUDGE_ENABLED: "maybe" };
  const result = await checkRequiredValues(env);
  assertEquals(result.ok, false);
  assertEquals(result.judgeError, "JUDGE_ENABLED 必须是 true 或 false");
  assertEquals(result.missing, []);
  assertEquals(result.placeholder, []);
  assertEquals(result.siteAddressError, null);
});

Deno.test("checkRequiredValues: JUDGE_ENABLED 未设置视为启用，judge 键必需", async () => {
  const env = okEnv();
  delete env.JUDGE_ENABLED;
  const result = await checkRequiredValues(env);
  assertEquals(result.judgeEnabled, true);
  assertEquals(result.missing, [
    "JUDGE_DOCKER_SOCKET",
    "JUDGE_DOCKER_SOCKET_GID",
  ]);
  assertEquals(result.ok, false);
});

Deno.test("checkRequiredValues: JUDGE_ENABLED 空串同样视为启用", async () => {
  const result = await checkRequiredValues(okEnv({ JUDGE_ENABLED: "" }));
  assertEquals(result.judgeEnabled, true);
  assertEquals(result.missing, [
    "JUDGE_DOCKER_SOCKET",
    "JUDGE_DOCKER_SOCKET_GID",
  ]);
});

Deno.test("checkRequiredValues: JUDGE_ENABLED=false 不要求 judge 键", async () => {
  const result = await checkRequiredValues(okEnv({ JUDGE_ENABLED: "false" }));
  assertEquals(result.judgeEnabled, false);
  assertEquals(result.missing, []);
  assertEquals(result.ok, true);
});

Deno.test("checkRequiredValues: judge 启用时 socket/GID 缺失进 missing", async () => {
  const report = await checkRequiredValues(okEnv({ JUDGE_ENABLED: "true" }));
  assertEquals(report.missing, [
    "JUDGE_DOCKER_SOCKET",
    "JUDGE_DOCKER_SOCKET_GID",
  ]);
  // GID 已填但非数字时也判错（对照 bash :747）。
  const badGid = await checkRequiredValues(okEnv({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "abc",
  }));
  assertEquals(badGid.missing, ["JUDGE_DOCKER_SOCKET_GID"]);
});

// ---------------- 站点地址 ----------------

Deno.test("isIpv4Address: 接受合法 IPv4，拒绝越界与畸形", () => {
  for (const ip of ["192.0.2.10", "0.0.0.0", "255.255.255.255", "10.0.0.1"]) {
    assertEquals(isIpv4Address(ip), true, ip);
  }
  for (
    const ip of [
      "256.0.0.1",
      "1.2.3",
      "1.2.3.4.5",
      "01a.2.3.4",
      "1.2.3.-1",
      "",
      "999.999.999.999",
    ]
  ) {
    assertEquals(isIpv4Address(ip), false, ip);
  }
});

Deno.test("isSiteAddress: 逐字对照 bash 正则（域名 vs IP vs 非法）", () => {
  // bash 正则 ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ 且必须含点，
  // 因此 "a..b" / 多段数字都算「合法」（与直觉不符但必须一致）。
  for (
    const addr of [
      "oj.example.com",
      "192.0.2.10",
      "a.b",
      "x.io",
      "my-oj.internal",
      "a1.b2.c3",
      "a..b",
      "1.2.3.4.5.6",
      "bad-.com",
    ]
  ) {
    assertEquals(isSiteAddress(addr), true, addr);
  }
  for (
    const addr of [
      "",
      "localhost",
      "oj",
      "https://oj.example.com",
      "-bad.com",
      ".com",
      "com.",
      "oj example.com",
      "oj_example.com",
      "a",
    ]
  ) {
    assertEquals(isSiteAddress(addr), false, addr);
  }
});

Deno.test("checkRequiredValues: DOMAIN 非法时 siteAddressError 非空", async () => {
  const report = await checkRequiredValues(okEnv({ DOMAIN: "localhost" }));
  assertEquals(report.ok, false);
  assertEquals(report.siteAddressError, "网站地址必须是域名或服务器 IP");
  assertEquals(report.missing, []);
});

// ---------------- 后半段取值约束（bash :718-764） ----------------

Deno.test("checkRequiredValues: EMAIL_PROVIDER 枚举外报错（对照 :731-734）", async () => {
  const report = await checkRequiredValues(okEnv({ EMAIL_PROVIDER: "smtp" }));
  assertEquals(report.ok, false);
  assertEquals(
    report.errors.includes(
      "  - EMAIL_PROVIDER 必须是 aliyun、tencent 或 disabled",
    ),
    true,
  );
  // 枚举错误不改变 missing：EMAIL_PROVIDER 已有值，不算未配置。
  assertEquals(report.missing, []);
  assertEquals(report.placeholder, []);
  // 三个受支持取值都不报枚举错误。
  for (const provider of EMAIL_PROVIDERS) {
    const ok = await checkRequiredValues(okEnv({ EMAIL_PROVIDER: provider }));
    assertEquals(
      ok.errors.includes(
        "  - EMAIL_PROVIDER 必须是 aliyun、tencent 或 disabled",
      ),
      false,
      provider,
    );
  }
});

Deno.test("checkRequiredValues: EMAIL_PROVIDER=aliyun 要求三个阿里云键（对照 :718-725）", async () => {
  const report = await checkRequiredValues(okEnv({ EMAIL_PROVIDER: "aliyun" }));
  assertEquals(report.ok, false);
  assertEquals(report.missing, [...ALIYUN_EMAIL_KEYS]);
  for (const key of ALIYUN_EMAIL_KEYS) {
    assertEquals(
      report.errors.includes(`  - ${key} 未配置或仍是占位值`),
      true,
      key,
    );
  }
  // 条件键在 .env.prod 里是占位值时同样报"未配置或仍是占位值"。
  const placeholder = await checkRequiredValues(okEnv({
    EMAIL_PROVIDER: "aliyun",
    ALIBABA_ACCESS_KEY_ID: "change-me",
  }));
  assertEquals(placeholder.missing, [
    "ALIBABA_ACCESS_KEY_ID",
    "ALIBABA_ACCESS_KEY_SECRET",
    "ALIBABA_FROM_EMAIL",
  ]);
});

Deno.test("checkRequiredValues: EMAIL_PROVIDER=tencent 要求四个腾讯云键（对照 :726-731）", async () => {
  const report = await checkRequiredValues(
    okEnv({ EMAIL_PROVIDER: "tencent" }),
  );
  assertEquals(report.ok, false);
  assertEquals(report.missing, [...TENCENT_EMAIL_KEYS]);
  for (const key of TENCENT_EMAIL_KEYS) {
    assertEquals(
      report.errors.includes(`  - ${key} 未配置或仍是占位值`),
      true,
      key,
    );
  }
  // disabled 分支不要求任何邮件键。
  const disabled = await checkRequiredValues(
    okEnv({ EMAIL_PROVIDER: "disabled" }),
  );
  assertEquals(disabled.missing, []);
  assertEquals(disabled.ok, true);
});

Deno.test("checkRequiredValues: 邮件分支填齐后 all-green（分支互不越界）", async () => {
  const aliyun = await checkRequiredValues(okEnv({
    EMAIL_PROVIDER: "aliyun",
    ALIBABA_ACCESS_KEY_ID: "ak-id",
    ALIBABA_ACCESS_KEY_SECRET: "ak-secret",
    ALIBABA_FROM_EMAIL: "noreply@oj.beta.test",
  }));
  assertEquals(aliyun.ok, true);
  assertEquals(aliyun.missing, []);
  assertEquals(aliyun.errors, []);

  const tencent = await checkRequiredValues(okEnv({
    EMAIL_PROVIDER: "tencent",
    TENCENT_SECRET_ID: "id",
    TENCENT_SECRET_KEY: "key",
    TENCENT_FROM_EMAIL: "noreply@oj.beta.test",
    TENCENT_REGION: "ap-guangzhou",
  }));
  assertEquals(tencent.ok, true);
  assertEquals(tencent.missing, []);
  assertEquals(tencent.errors, []);

  // 选中 tencent 时缺失的阿里云键不应被要求（bash 只走当前分支）。
  const tencentOnly = await checkRequiredValues(okEnv({
    EMAIL_PROVIDER: "tencent",
    TENCENT_SECRET_ID: "id",
    TENCENT_SECRET_KEY: "key",
    TENCENT_FROM_EMAIL: "noreply@oj.beta.test",
    TENCENT_REGION: "ap-guangzhou",
    ALIBABA_ACCESS_KEY_ID: "",
  }));
  assertEquals(tencentOnly.missing, []);
  assertEquals(tencentOnly.ok, true);
});
Deno.test("checkRequiredValues: STORAGE_PROVIDER 必须恰为 s3（对照 :739-742）", async () => {
  for (const bad of ["minio", "S3", "s3 ", "local", "s30"]) {
    const report = await checkRequiredValues(okEnv({ STORAGE_PROVIDER: bad }));
    assertEquals(report.ok, false, bad);
    assertEquals(
      report.errors.includes("  - STORAGE_PROVIDER 必须设置为 s3"),
      true,
      bad,
    );
  }
  const ok = await checkRequiredValues(okEnv({ STORAGE_PROVIDER: "s3" }));
  assertEquals(ok.errors.includes("  - STORAGE_PROVIDER 必须设置为 s3"), false);
  // 空值走 missing（未配置）而非取值错误，且不重复报错。
  const empty = await checkRequiredValues(okEnv({ STORAGE_PROVIDER: "" }));
  assertEquals(empty.missing, ["STORAGE_PROVIDER"]);
  assertEquals(empty.errors, ["  - STORAGE_PROVIDER 未配置或仍是占位值"]);
});

Deno.test("checkRequiredValues: JWT_SECRET 不得含 test（对照 :743-746）", async () => {
  // bash 用子串匹配 `*test*`（区分大小写）。
  for (
    const bad of [
      "my-test-secret",
      "secret-test",
      "test-secret-value",
    ]
  ) {
    const report = await checkRequiredValues(okEnv({ JWT_SECRET: bad }));
    assertEquals(report.ok, false, bad);
    assertEquals(
      report.errors.includes("  - JWT_SECRET 不得使用测试密钥"),
      true,
      bad,
    );
  }
  // 大小写敏感：TESTING / TEST 不含小写子串 test -> 不报错。
  for (const legal of ["TESTING-secret-value", "TEST-Secret", "te-st"]) {
    const upper = await checkRequiredValues(okEnv({ JWT_SECRET: legal }));
    assertEquals(
      upper.errors.includes("  - JWT_SECRET 不得使用测试密钥"),
      false,
      legal,
    );
  }
  // 单个 "test" 先被 isPlaceholder 拦截（进 placeholder），不会同时报测试密钥错误。
  const placeholder = await checkRequiredValues(okEnv({ JWT_SECRET: "test" }));
  assertEquals(placeholder.placeholder, ["JWT_SECRET"]);
  assertEquals(placeholder.errors, ["  - JWT_SECRET 未配置或仍是占位值"]);
});

Deno.test("checkRequiredValues: APP_URL 协议与 HTTP 模式（对照 :751-759）", async () => {
  // 非 http(s) 前缀 -> 报协议错误（无论是否允许不安全 HTTP）。
  for (
    const bad of ["oj.beta.test", "ftp://oj.beta.test", "//oj.beta.test"]
  ) {
    const report = await checkRequiredValues(okEnv({ APP_URL: bad }));
    assertEquals(report.ok, false, bad);
    assertEquals(
      report.errors.includes("  - 网站完整网址必须以 http:// 或 https:// 开头"),
      true,
      bad,
    );
  }
  // http:// 且 NOJ_ALLOW_INSECURE_HTTP 非 "true" -> 报"临时 HTTP 模式"。
  for (const allow of [undefined, "", "false", "TRUE", "True"]) {
    const report = await checkRequiredValues(okEnv({
      APP_URL: "http://oj.beta.test",
      NOJ_ALLOW_INSECURE_HTTP: allow,
    }));
    assertEquals(report.ok, false, String(allow));
    assertEquals(
      report.errors.includes(
        "  - 网站完整网址使用 HTTP 时，必须明确选择临时 HTTP 模式",
      ),
      true,
      String(allow),
    );
    // 已以 http:// 开头，不再报协议错误。
    assertEquals(
      report.errors.includes("  - 网站完整网址必须以 http:// 或 https:// 开头"),
      false,
    );
  }
  // http:// + NOJ_ALLOW_INSECURE_HTTP=true -> 通过。
  const insecureOk = await checkRequiredValues(okEnv({
    APP_URL: "http://oj.beta.test",
    NOJ_ALLOW_INSECURE_HTTP: "true",
  }));
  assertEquals(insecureOk.ok, true);
  assertEquals(insecureOk.errors, []);
  // https:// 无需 NOJ_ALLOW_INSECURE_HTTP。
  const secure = await checkRequiredValues(okEnv());
  assertEquals(secure.ok, true);
});

Deno.test("checkRequiredValues: NOJ_VERSION 必须是 Release 标签（对照 :760-764）", async () => {
  const good = ["v0.1.0", "0.1.1-rc.1", "v1.2.3", "v0.9.5-rc.1", "0.1.0"];
  for (const version of good) {
    const report = await checkRequiredValues(okEnv({ NOJ_VERSION: version }));
    assertEquals(
      report.errors.includes(
        "  - NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.1.1-rc.1）",
      ),
      false,
      version,
    );
  }
  const bad = [
    "latest",
    "0.1",
    "v0.1",
    "dev",
    "v0.1.0 x",
    "1.0.0+build.5",
  ];
  for (const version of bad) {
    const report = await checkRequiredValues(okEnv({ NOJ_VERSION: version }));
    assertEquals(report.ok, false, version);
    assertEquals(
      report.errors.includes(
        "  - NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.1.1-rc.1）",
      ),
      true,
      version,
    );
  }
});

Deno.test("checkEnvFileMode: .env.prod 权限必须为 600 或 400（对照 :658-665）", () => {
  const file = "/opt/noj/.env.prod";
  assertEquals(checkEnvFileMode("600", file), { kind: "ok", mode: "600" });
  assertEquals(checkEnvFileMode("400", file), { kind: "ok", mode: "400" });
  for (const mode of ["640", "644", "660", "777", "000"]) {
    const verdict = checkEnvFileMode(mode, file);
    assertEquals(verdict.kind, "error", mode);
    assertEquals(
      verdict.kind === "error" ? verdict.message : "",
      `生产配置文件权限必须为 600 或 400：${file}`,
      mode,
    );
  }
  // stat 读不出权限 -> bash 的硬错误（fail）。
  const unreadable = checkEnvFileMode(null, file);
  assertEquals(unreadable.kind, "unreadable");
  assertEquals(
    unreadable.kind === "unreadable" ? unreadable.message : "",
    `无法读取生产配置文件权限：${file}`,
  );
});

Deno.test("ENV_VALUE_RULES: 覆盖 4 类取值约束（GID 由 judge 分支单独处理）", async () => {
  const keys = ENV_VALUE_RULES.map((rule) => rule.key);
  for (
    const key of [
      "STORAGE_PROVIDER",
      "JWT_SECRET",
      "APP_URL",
      "NOJ_VERSION",
    ]
  ) {
    assertEquals(keys.includes(key), true, key);
  }
  // GID 规则不进通用取值约束表（错误语义不同，见 config-schema.ts 文档）。
  assertEquals(keys.includes("JUDGE_DOCKER_SOCKET_GID"), false);
  // judge 启用时 GID 非数字判错（对照 :747-750）。
  const gid = await checkRequiredValues(okEnv({
    JUDGE_ENABLED: "true",
    JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
    JUDGE_DOCKER_SOCKET_GID: "abc",
  }));
  assertEquals(gid.missing, ["JUDGE_DOCKER_SOCKET_GID"]);
  assertEquals(
    gid.errors.includes("  - JUDGE_DOCKER_SOCKET_GID 必须是数字"),
    true,
  );
  // judge 关闭时 GID 不参与判定（bash 同样只在 judge_enabled 时检查）。
  const off = await checkRequiredValues(okEnv({
    JUDGE_ENABLED: "false",
    JUDGE_DOCKER_SOCKET_GID: "abc",
  }));
  assertEquals(off.missing, []);
  assertEquals(off.errors, []);
  assertEquals(off.ok, true);
});
Deno.test("checkRequiredValues: 汇总 ok 且 judgeEnabled=false", async () => {
  const result = await checkRequiredValues(okEnv());
  assertEquals(result.ok, true);
  assertEquals(result.judgeEnabled, false);
  assertEquals(result.siteAddressError, null);
  assertEquals(result.judgeError, null);
});

// ---------------- 端口 ----------------

Deno.test("checkPortValue: 缺省 8080，边界 1/65535 通过", async () => {
  assertEquals(await checkPortValue({}), {
    port: 8080,
    error: null,
    warning: null,
  });
  assertEquals((await checkPortValue({ NGINX_PORT: "" })).port, 8080);
  assertEquals((await checkPortValue({ NGINX_PORT: "1" })).port, 1);
  assertEquals((await checkPortValue({ NGINX_PORT: "65535" })).port, 65535);
});

Deno.test("checkPortValue: 非数字与越界端口报错", async () => {
  for (const raw of ["0", "65536", "abc", "80.5", "-1", " 80", "8080x"]) {
    const result = await checkPortValue({ NGINX_PORT: raw });
    assertEquals(result.error, "NGINX_PORT 必须是 1-65535 的端口号", raw);
  }
});

Deno.test("checkPortValue: 端口被 lsof 监听时给出冲突告警", async () => {
  const calls: string[][] = [];
  const result = await checkPortValue({ NGINX_PORT: "8080" }, {
    runner: recordingRunner(calls),
  });
  assertEquals(result.error, null);
  assertEquals(calls[0], ["lsof", "-nP", "-iTCP:8080", "-sTCP:LISTEN"]);
  assertEquals(result.warning?.includes("端口冲突"), true);
});

// ---------------- judge socket ----------------

Deno.test("checkJudgeSocket: 拒绝宿主 Docker socket", async () => {
  for (const path of ["/var/run/docker.sock", "/run/docker.sock"]) {
    const result = await checkJudgeSocket({
      JUDGE_DOCKER_SOCKET: path,
      JUDGE_DOCKER_SOCKET_GID: "10001",
    }, { socketExists: () => Promise.resolve(true) });
    assertEquals(result.ok, false);
    assertEquals(
      result.error,
      `禁止将应用宿主机 Docker socket 挂载给 judge：${path}`,
    );
  }
});

Deno.test("checkJudgeSocket: socket 不存在时报错，存在时通过", async () => {
  const missing = await checkJudgeSocket(
    { JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock" },
    { socketExists: () => Promise.resolve(false) },
  );
  assertEquals(missing.ok, false);
  assertEquals(
    missing.error,
    "Judge 隔离 Docker socket 不存在：/run/noj-judge/docker.sock",
  );

  const ok = await checkJudgeSocket(
    { JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock" },
    { socketExists: () => Promise.resolve(true) },
  );
  assertEquals(ok.ok, true);
  assertEquals(ok.error, null);
});

Deno.test("checkJudgeSocket: GID 非数字时报错", async () => {
  const result = await checkJudgeSocket(
    {
      JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "root",
    },
    { socketExists: () => Promise.resolve(true) },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error, "JUDGE_DOCKER_SOCKET_GID 必须是数字");
});

// ---------------- 口令文件 ----------------

Deno.test("passphraseFileMode: 读取权限位（含 400）", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const path = join(dir, "passphrase");
    await Deno.writeTextFile(path, "x");
    await Deno.chmod(path, 0o640);
    assertEquals(await passphraseFileMode(path), "640");
    await Deno.chmod(path, 0o400);
    assertEquals(await passphraseFileMode(path), "400");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 缺失时自动生成 600 口令并回填配置键", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "noj", "backup-passphrase");
    const result = await ensureBackupPassphrase({}, { targetFile: target });
    assertEquals(result.created, true);
    assertEquals(result.path, target);
    assertEquals(result.error, null);
    assertEquals(result.envUpdate, { NOJ_BACKUP_PASSPHRASE_FILE: target });
    // 口令是 32 字节 hex（64 位小写十六进制），不落空。
    assertEquals(/^[0-9a-f]{64}$/.test(result.passphrase ?? ""), true);
    assertEquals(await Deno.readTextFile(target), result.passphrase);
    assertEquals((await Deno.stat(target)).mode! & 0o777, 0o600);
    // 父目录 700（对照 bash mkdir -p -m 700）。
    assertEquals((await Deno.stat(join(dir, "noj"))).mode! & 0o777, 0o700);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 已存在时复用且不改写", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "passphrase");
    await Deno.writeTextFile(target, "existing-secret\n");
    await Deno.chmod(target, 0o600);
    const result = await ensureBackupPassphrase({}, { targetFile: target });
    assertEquals(result.created, false);
    assertEquals(result.passphrase, null);
    assertEquals(result.envUpdate, null);
    assertEquals(await Deno.readTextFile(target), "existing-secret\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 权限非 600/400 时拒绝并给可操作提示", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "passphrase");
    await Deno.writeTextFile(target, "x");
    await Deno.chmod(target, 0o644);
    const result = await ensureBackupPassphrase({}, { targetFile: target });
    assertEquals(result.created, false);
    assertEquals(result.path, target);
    assertEquals(
      result.error,
      `GPG 备份口令文件权限必须为 600 或 400：${target}`,
    );
    // 不改权限、不覆盖内容（bash 的 fail 即退出，无副作用）。
    assertEquals((await Deno.stat(target)).mode! & 0o777, 0o644);
    assertEquals(await Deno.readTextFile(target), "x");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 路径不是普通文件时拒绝", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "dir-as-passphrase");
    await Deno.mkdir(target);
    const result = await ensureBackupPassphrase({}, { targetFile: target });
    assertEquals(result.error, `GPG 备份口令路径不是普通文件：${target}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 配置键已有时不回填配置", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "passphrase");
    const result = await ensureBackupPassphrase(
      { NOJ_BACKUP_PASSPHRASE_FILE: target },
      { targetFile: target },
    );
    assertEquals(result.created, true);
    assertEquals(result.envUpdate, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backupPassphrasePath: 优先级为旗标 > 显式 > 配置键 > 默认", () => {
  assertEquals(
    backupPassphrasePath({ flag: "/tmp/flag", configured: "/tmp/cfg" }),
    "/tmp/flag",
  );
  assertEquals(
    backupPassphrasePath({ explicit: "/tmp/exp", configured: "/tmp/cfg" }),
    "/tmp/exp",
  );
  assertEquals(backupPassphrasePath({ configured: "/tmp/cfg" }), "/tmp/cfg");
  assertEquals(backupPassphrasePath({}), DEFAULT_BACKUP_PASSPHRASE_FILE);
});

// ---------------- 面板检测 ----------------

Deno.test("detectPanel: auto 模式按目录/命令存在性探测", async () => {
  const paths = {
    panelRoot: "/www/server/panel",
    panelCommand: "/usr/bin/bt",
  };
  assertEquals(
    await detectPanel("auto", paths, {
      dirExists: (p: string) => Promise.resolve(p === paths.panelRoot),
      execExists: () => Promise.resolve(false),
    }),
    "baota",
  );
  assertEquals(
    await detectPanel("auto", paths, {
      dirExists: () => Promise.resolve(false),
      execExists: (p: string) => Promise.resolve(p === paths.panelCommand),
    }),
    "baota",
  );
  assertEquals(
    await detectPanel("auto", paths, {
      dirExists: () => Promise.resolve(false),
      execExists: () => Promise.resolve(false),
    }),
    "none",
  );
});

Deno.test("detectPanel: baota 强制命中，none 不探测", async () => {
  let probed = 0;
  const probe = {
    dirExists: () => {
      probed++;
      return Promise.resolve(true);
    },
    execExists: () => {
      probed++;
      return Promise.resolve(true);
    },
  };
  assertEquals(await detectPanel("baota", {}, probe), "baota");
  assertEquals(await detectPanel("none", {}, probe), "none");
  assertEquals(probed, 0);
});

Deno.test("panelGuidance: 仅 baota 输出引导文本", () => {
  assertEquals(panelGuidance("none"), null);
  const text = panelGuidance("baota");
  assertEquals(text?.includes("宝塔"), true);
  assertEquals(text?.includes("127.0.0.1:NGINX_PORT"), true);
  assertEquals(text?.includes("rootless"), true);
});

Deno.test("panelGuidance: 非 baota 模式返回 null，baota 经 IO 输出", () => {
  assertEquals(panelGuidance("auto"), null);
  const io = new FakeIO([]);
  showPanelGuidance("baota", io);
  assertEquals(io.output().includes("宝塔兼容模式"), true);
  // bash :817 的 ok 行必须真实输出（此前注释声称有、实现却没有）。
  assertEquals(io.output().includes(PANEL_GUIDANCE_OK_LINE), true);
  assertEquals(PANEL_GUIDANCE_OK_LINE, "✓ 宝塔兼容提示已启用");
  // 非 baota 模式零输出。
  const silent = new FakeIO([]);
  showPanelGuidance("none", silent);
  showPanelGuidance("auto", silent);
  assertEquals(silent.output(), "");
});

Deno.test("面板常数: 默认值对应 deploy.sh:31-32 的注入默认", () => {
  assertEquals(DEFAULT_PANEL_ROOT, "/www/server/panel");
  assertEquals(DEFAULT_PANEL_COMMAND, "/usr/bin/bt");
});

// ---------------- 镜像验签 ----------------

Deno.test("verifyImageSignatures: 关闭时零调用", async () => {
  const calls: string[][] = [];
  const result = await verifyImageSignatures(okEnv(), {
    runner: recordingRunner(calls),
    cosignAvailable: () => Promise.resolve(true),
  });
  assertEquals(result.ok, true);
  assertEquals(result.skipped, true);
  assertEquals(result.error, null);
  assertEquals(calls, []);
  assertEquals(result.digests, []);
});

Deno.test("verifyImageSignatures: 校验形状（imagetools + cosign 参数）", async () => {
  const calls: string[][] = [];
  const env = okEnv({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" });
  const result = await verifyImageSignatures(env, {
    runner: recordingRunner(calls, {
      digests: imageDigests("ghcr.io/neuro-oj"),
    }),
    cosignAvailable: () => Promise.resolve(true),
  });
  assertEquals(result.ok, true);
  assertEquals(result.skipped, false);
  assertEquals(result.digests.length, 3);
  assertEquals(result.digests[0], {
    image: "ghcr.io/neuro-oj/noj-server:v0.9.5",
    name: "noj-server",
    digest: DIGEST(1),
  });

  assertEquals(calls[0], [
    "docker",
    "buildx",
    "imagetools",
    "inspect",
    "ghcr.io/neuro-oj/noj-server:v0.9.5",
  ]);
  assertEquals(calls[1], [
    "cosign",
    "verify",
    "--certificate-identity-regexp",
    DEFAULT_COSIGN_IDENTITY_REGEX,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    `ghcr.io/neuro-oj/noj-server:v0.9.5@${DIGEST(1)}`,
  ]);
  // judge 关闭时 3 个镜像 → 3 次 inspect + 3 次 verify。
  assertEquals(calls.length, 6);
});

Deno.test("verifyImageSignatures: judge 启用时追加三个 judge 镜像", async () => {
  const calls: string[][] = [];
  const result = await verifyImageSignatures(
    okEnv({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true", JUDGE_ENABLED: "true" }),
    {
      runner: recordingRunner(calls, {
        digests: imageDigests("ghcr.io/neuro-oj"),
      }),
      cosignAvailable: () => Promise.resolve(true),
    },
  );
  assertEquals(result.digests.length, 6);
  assertEquals(calls.length, 12);
  assertEquals(result.digests[5]?.name, "noj-solution-python");
});

Deno.test("verifyImageSignatures: cosign 缺失时报错且不执行任何命令", async () => {
  const calls: string[][] = [];
  const result = await verifyImageSignatures(
    okEnv({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" }),
    {
      runner: recordingRunner(calls),
      cosignAvailable: () => Promise.resolve(false),
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("找不到 Cosign"), true);
  assertEquals(calls, []);
});

Deno.test("verifyImageSignatures: digest 无法解析时报错", async () => {
  const calls: string[][] = [];
  const result = await verifyImageSignatures(
    okEnv({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" }),
    {
      runner: recordingRunner(calls, { digests: {} }),
      cosignAvailable: () => Promise.resolve(true),
    },
  );
  assertEquals(result.ok, false);
  assertEquals(
    result.error,
    "无法解析生产镜像 digest：ghcr.io/neuro-oj/noj-server:v0.9.5",
  );
  // 解析失败即停：不再调用 cosign。
  assertEquals(calls.every((c) => c[0] === "docker"), true);
});

Deno.test("verifyImageSignatures: cosign 退出码非 0 → ok=false 且带镜像引用", async () => {
  const calls: string[][] = [];
  const failed = `ghcr.io/neuro-oj/noj-ui:v0.9.5@${DIGEST(2)}`;
  const result = await verifyImageSignatures(
    okEnv({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" }),
    {
      runner: recordingRunner(calls, {
        digests: imageDigests("ghcr.io/neuro-oj"),
        failures: new Set([failed]),
      }),
      cosignAvailable: () => Promise.resolve(true),
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error, `生产镜像 Cosign 签名校验失败：${failed}`);
  // noj-server 已通过，noj-ui 失败，后续 noj-llm-gateway 不再校验。
  assertEquals(result.digests.length, 1);
  assertEquals(calls.filter((c) => c[0] === "cosign").length, 2);
});

Deno.test("verifyImageSignatures: 自定义 registry 与 identity 生效", async () => {
  const calls: string[][] = [];
  const registry = "registry.example.test/noj";
  await verifyImageSignatures(
    okEnv({
      NOJ_ENFORCE_IMAGE_SIGNATURES: "true",
      NOJ_IMAGE_REGISTRY: registry,
      NOJ_COSIGN_CERT_IDENTITY_REGEX: "^https://ci.test/.*$",
    }),
    {
      runner: recordingRunner(calls, {
        digests: imageDigests(registry),
      }),
      cosignAvailable: () => Promise.resolve(true),
    },
  );
  assertEquals(calls[0]?.[4], `${registry}/noj-server:v0.9.5`);
  assertEquals(calls[1]?.[3], "^https://ci.test/.*$");
});

// ---------------- 部署元数据 ----------------

Deno.test("recordDeploymentMetadata: 写出 manifest 权限 600 且格式固定", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-meta-" });
  try {
    const result = await recordDeploymentMetadata({
      version: "v0.9.5",
      at: new Date("2026-09-19T00:00:00Z"),
      verified: [
        {
          image: "ghcr.io/neuro-oj/noj-ui:x",
          name: "noj-ui",
          digest: DIGEST(2),
        },
        {
          image: "ghcr.io/neuro-oj/noj-server:x",
          name: "noj-server",
          digest: DIGEST(1),
        },
      ],
      backupDir: dir,
    });
    assertEquals(result.written, true);
    const path = join(dir, "current-deployment.txt");
    assertEquals(result.path, path);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    const text = await Deno.readTextFile(path);
    assertEquals(text.includes("version=v0.9.5\n"), true);
    assertEquals(text.includes("recorded_at=2026-09-19T00:00:00Z\n"), true);
    // digest 行按字典序排序。
    const lines = text.trim().split("\n");
    assertEquals(lines.slice(2), [
      `noj-server ${DIGEST(1)}`,
      `noj-ui ${DIGEST(2)}`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("recordDeploymentMetadata: 无验签结果时零副作用", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-meta-" });
  try {
    const result = await recordDeploymentMetadata({
      version: "v0.9.5",
      at: new Date(),
      verified: [],
      backupDir: dir,
    });
    assertEquals(result.written, false);
    assertEquals(result.path, null);
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------- 向导路径判定 ----------------

Deno.test("wizardNeedsInteractiveInput: 核心键缺失或占位即需要交互", () => {
  assertEquals(wizardNeedsInteractiveInput(okEnv()), false);
  assertEquals(wizardNeedsInteractiveInput(okEnv({ DOMAIN: "" })), true);
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({ NOJ_VERSION: "v0.0.0-change-me" })),
    true,
  );
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({ EMAIL_PROVIDER: "" })),
    true,
  );
  // judge 未设置视为启用 → 无 socket 即需要交互（T2 carry-forward）。
  const noJudge = okEnv();
  delete noJudge.JUDGE_ENABLED;
  assertEquals(wizardNeedsInteractiveInput(noJudge), true);
});

Deno.test("wizardNeedsInteractiveInput: 邮件/Judge 条件键缺失即需要交互", () => {
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({
      EMAIL_PROVIDER: "aliyun",
      ALIBABA_ACCESS_KEY_ID: "",
    })),
    true,
  );
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({
      EMAIL_PROVIDER: "aliyun",
      ALIBABA_ACCESS_KEY_ID: "ak",
      ALIBABA_ACCESS_KEY_SECRET: "sk",
      ALIBABA_FROM_EMAIL: "noreply@oj.beta.test",
    })),
    false,
  );
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({ JUDGE_ENABLED: "true" })),
    true,
  );
  assertEquals(
    wizardNeedsInteractiveInput(okEnv({
      JUDGE_ENABLED: "true",
      JUDGE_DOCKER_SOCKET: "/run/noj-judge/docker.sock",
      JUDGE_DOCKER_SOCKET_GID: "10001",
    })),
    false,
  );
});

// ---------------- 交互向导 ----------------

Deno.test("runConfigWizard: 非 TTY 且缺必需输入时明确报错，不进交互循环", async () => {
  const io = new FakeIO([]);
  await assertRejects(
    () => runConfigWizard(io, okEnv({ DOMAIN: "" }), { isTty: false }),
    Error,
    "非交互环境",
  );
  // 关键回归（#517 E10）：一次 read 都没有发生。
  assertEquals(io.answers.length, 0);
  assertEquals(io.lineReads, 0);
  assertEquals(io.secretReads, 0);
  assertEquals(io.output().includes("请输入编号"), false);
});

Deno.test("runConfigWizard: 非 TTY 且邮件条件键缺失时拒绝", async () => {
  const io = new FakeIO([]);
  await assertRejects(
    () =>
      runConfigWizard(
        io,
        okEnv({
          EMAIL_PROVIDER: "aliyun",
          ALIBABA_ACCESS_KEY_ID: "",
        }),
        { isTty: false },
      ),
    Error,
    "非交互环境",
  );
  assertEquals(io.writes.length, 0);
});

Deno.test("runConfigWizard: 非 TTY 但配置完整时不进入交互", async () => {
  const io = new FakeIO([]);
  const result = await runConfigWizard(io, okEnv(), { isTty: false });
  assertEquals(result.cancelled, false);
  assertEquals(result.values["DOMAIN"], "oj.beta.test");
  assertEquals(io.writes.length, 0);
});

Deno.test("runConfigWizard: HTTPS + disabled 邮件 + 不装 judge 的输入序列", async () => {
  const io = new FakeIO([
    "v0.9.6", // 版本
    "oj.prod.test", // 网站地址
    "y", // HTTPS
    "disabled", // 邮件服务
    "n", // 不安装 Judge
    "y", // 写入配置
  ]);
  const result = await runConfigWizard(io, {}, { isTty: true });
  assertEquals(result.cancelled, false);
  assertEquals(result.values["NOJ_VERSION"], "v0.9.6");
  assertEquals(result.values["DOMAIN"], "oj.prod.test");
  assertEquals(result.values["APP_URL"], "https://oj.prod.test");
  assertEquals(result.values["CORS_ALLOWED_ORIGINS"], "https://oj.prod.test");
  assertEquals(result.values["NOJ_ALLOW_INSECURE_HTTP"], "false");
  assertEquals(result.values["EMAIL_PROVIDER"], "disabled");
  assertEquals(result.values["JUDGE_ENABLED"], "false");
  // 跳过邮件时清空留存的邮件键（对照 bash :548-551）。
  assertEquals(result.values["TENCENT_REGION"], "");
  assertEquals(result.values["ALIBABA_ACCESS_KEY_ID"], "");
});

Deno.test("runConfigWizard: 临时 HTTP + aliyun + judge 的输入序列", async () => {
  const io = new FakeIO([
    "v0.9.6", // 版本
    "192.0.2.10", // IP（HTTPS 默认 n）
    "n", // 不使用 HTTPS
    "aliyun", // 邮件服务
    "ak-id-0001", // Access Key ID（secretInput）
    "ak-secret-0001", // Access Key Secret（secretInput）
    "noreply@oj.prod.test", // 发件邮箱
    "y", // 安装 Judge
    "/run/noj-judge/docker.sock", // socket
    "10001", // GID
    "y", // 写入
  ]);
  const result = await runConfigWizard(io, {}, { isTty: true });
  assertEquals(result.cancelled, false);
  assertEquals(result.values["APP_URL"], "http://192.0.2.10");
  assertEquals(result.values["NOJ_ALLOW_INSECURE_HTTP"], "true");
  assertEquals(result.values["EMAIL_PROVIDER"], "aliyun");
  assertEquals(result.values["ALIBABA_ACCESS_KEY_ID"], "ak-id-0001");
  assertEquals(result.values["ALIBABA_ACCESS_KEY_SECRET"], "ak-secret-0001");
  assertEquals(result.values["JUDGE_ENABLED"], "true");
  assertEquals(
    result.values["JUDGE_DOCKER_SOCKET"],
    "/run/noj-judge/docker.sock",
  );
  assertEquals(result.values["JUDGE_DOCKER_SOCKET_GID"], "10001");
});

Deno.test("runConfigWizard: secret 值绝不回显到任何 write 输出", async () => {
  const io = new FakeIO([
    "v0.9.6",
    "oj.prod.test",
    "y",
    "aliyun",
    "AKIDSECRETLITERAL",
    "AKSECRETLITERAL",
    "noreply@oj.prod.test",
    "n",
    "y",
  ]);
  const result = await runConfigWizard(io, {}, { isTty: true });
  const output = io.output();
  assertEquals(result.values["ALIBABA_ACCESS_KEY_ID"], "AKIDSECRETLITERAL");
  assertEquals(result.values["ALIBABA_ACCESS_KEY_SECRET"], "AKSECRETLITERAL");
  assertEquals(output.includes("AKIDSECRETLITERAL"), false);
  assertEquals(output.includes("AKSECRETLITERAL"), false);
  // 秘密输入必须走 no-echo 通道（readSecret），且提示确实展示过标签。
  assertEquals(io.secretReads, 2);
  assertEquals(
    io.prompts.some((p) => p.includes("阿里云 Access Key ID")),
    true,
  );
  assertEquals(
    io.prompts.some((p) => p.includes("阿里云 Access Key Secret")),
    true,
  );
  assertEquals(output.includes("配置已写入"), true);
});

Deno.test("runConfigWizard: 取消写入时返回 cancelled 且不产生写入副作用", async () => {
  const io = new FakeIO([
    "v0.9.6",
    "oj.prod.test",
    "y",
    "disabled",
    "n",
    "n", // 取消写入
  ]);
  const result = await runConfigWizard(io, {}, { isTty: true });
  assertEquals(result.cancelled, true);
  assertEquals(io.output().includes("正式配置未修改"), true);
});

Deno.test("runConfigWizard: 确认写入时落盘 .env.prod（父目录自动创建，权限 600）", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-wiz-" });
  try {
    const envFile = join(dir, "nested", ".env.prod");
    const io = new FakeIO([
      "v0.9.6",
      "oj.prod.test",
      "y",
      "disabled",
      "n",
      "y",
    ]);
    const result = await runConfigWizard(io, {}, { isTty: true, envFile });
    assertEquals(result.wroteEnvFile, true);
    // T3 carry-forward：writeEnvFileAtomic 不 mkdir，调用方保证父目录存在。
    assertEquals((await Deno.stat(envFile)).mode! & 0o777, 0o600);
    const entries = await readEnvFile(envFile);
    assertEquals(entries.get("DOMAIN"), "oj.prod.test");
    assertEquals(entries.get("APP_URL"), "https://oj.prod.test");
    assertEquals(entries.get("JUDGE_ENABLED"), "false");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runConfigWizard: 非法站点地址当场报错（对照 bash :456）", async () => {
  const io = new FakeIO([
    "v0.9.6",
    "https://oj.prod.test", // 非法：带 scheme
  ]);
  await assertRejects(
    () => runConfigWizard(io, {}, { isTty: true }),
    Error,
    "网站地址必须是域名或服务器 IP",
  );
});

Deno.test("runConfigWizard: judge GID 非数字时报错（对照 bash :581）", async () => {
  const io = new FakeIO([
    "v0.9.6",
    "oj.prod.test",
    "y",
    "disabled",
    "y", // 安装 judge
    "/run/noj-judge/docker.sock",
    "not-a-number", // GID
  ]);
  await assertRejects(
    () => runConfigWizard(io, {}, { isTty: true }),
    Error,
    "Judge Docker socket GID 必须是数字",
  );
});

Deno.test("runConfigWizard: 复用已填值的非占位当前值（密钥不再询问）", async () => {
  const io = new FakeIO([
    "v0.9.6", // 版本（默认沿用 v0.9.5）
    "oj.prod.test", // 域名
    "y", // HTTPS
    "aliyun", // 邮件（沿用）
    "n", // judge
    "y", // 写入
  ]);
  const env = okEnv({
    EMAIL_PROVIDER: "aliyun",
    ALIBABA_ACCESS_KEY_ID: "existing-ak",
    ALIBABA_ACCESS_KEY_SECRET: "existing-sk",
    ALIBABA_FROM_EMAIL: "noreply@oj.prod.test",
  });
  const result = await runConfigWizard(io, env, { isTty: true });
  // 复用的密钥原样保留，不进入 secretInput。
  assertEquals(io.secretReads, 0);
  assertEquals(result.values["ALIBABA_ACCESS_KEY_ID"], "existing-ak");
  assertEquals(result.values["ALIBABA_ACCESS_KEY_SECRET"], "existing-sk");
  assertEquals(result.values["EMAIL_PROVIDER"], "aliyun");
});

// ---------------- 口令生成 ----------------

Deno.test("generateSecret: 64 位小写 hex，永不重复", () => {
  const a = generateSecret();
  const b = generateSecret();
  assertEquals(/^[0-9a-f]{64}$/.test(a), true);
  assertEquals(/^[0-9a-f]{64}$/.test(b), true);
  assertEquals(a === b, false);
});

// ---------------- 口令回填（ensure_backup_passphrase :948） ----------------

Deno.test("ensureBackupPassphrase: 进程环境显式指定口令时不回填配置", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "passphrase");
    // 模拟 `NOJ_BACKUP_PASSPHRASE_FILE=/tmp/x noj-cli ...`：进程环境已给出路径，
    // bash :948 的 `-z "${NOJ_BACKUP_PASSPHRASE_FILE:-}"` 因此为假 → 不回填。
    const result = await ensureBackupPassphrase({}, {
      targetFile: target,
      explicitConfigured: true,
    });
    assertEquals(result.created, true);
    assertEquals(result.error, null);
    assertEquals(result.envUpdate, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureBackupPassphrase: 旗标与配置键都未给出时才回填配置", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-pass-" });
  try {
    const target = join(dir, "passphrase");
    const result = await ensureBackupPassphrase({}, { targetFile: target });
    assertEquals(result.created, true);
    assertEquals(result.envUpdate, {
      NOJ_BACKUP_PASSPHRASE_FILE: target,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
