/**
 * 生产 env 注入一致性门禁。
 *
 * 背景（2026-10-04 发布前检查）：`docker-compose.prod.yml` 不使用 `env_file`，各服务
 * 只能读到 `environment:` 中显式插值的变量。`.env.prod.example` 记录的变量若未在
 * compose 中插值，运维照文档配置后**静默无效**。实测漏网：
 * - 邮件凭据 `ALIBABA_*` / `TENCENT_*`：EMAIL_PROVIDER 非 disabled 时 core 启动期
 *   生产配置校验必失败；
 * - `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`（审计 G-03）：内网 Provider 无法放行；
 * - 此前 month 配额变量也出过同类问题（见 compose 内注释）。
 *
 * 规则：`.env.prod.example` 中出现的每个变量（含注释掉的 `# KEY=` 示例）必须在
 * compose 中以 `${KEY` 形式被插值，或登记在 {@link NOT_INJECTED} 并写明原因。
 */

/**
 * 不经 compose 插值的变量白名单：键为变量名，值为原因。
 *
 * 新增条目前请确认该变量确实**不需要**进入任何容器。
 */
export const NOT_INJECTED: Readonly<Record<string, string>> = {
  DOMAIN: "noj-cli 读取（生成 APP_URL 等派生值）",
  JUDGE_ENABLED: "noj-cli 读取（决定是否启用 judge profile）",
  NOJ_BACKUP_MIN_FREE_MB: "noj-cli backup 读取",
  NOJ_BACKUP_PASSPHRASE_FILE: "noj-cli backup 读取",
  NOJ_BACKUP_RETENTION_DAYS: "noj-cli backup 读取",
  NOJ_COSIGN_CERT_IDENTITY_REGEX: "noj-cli 镜像签名校验读取",
  NOJ_ENFORCE_IMAGE_SIGNATURES: "noj-cli 镜像签名校验读取",
  NO_COLOR: "noj-cli 终端输出读取；容器内着色由 LOG_COLOR 固定为 never",
  RUNTIME_LLM_GATEWAY_URL:
    "compose 固定为 http://llm-gateway:8001（仅手工部署需设置）",
  JUDGE_REQUIRE_ISOLATED_DOCKER:
    "compose 固定为 true（生产强护栏，不允许关闭）",
};

const EXAMPLE_KEY_RE = /^#?\s*([A-Z][A-Z0-9_]*)=/gm;
const COMPOSE_INTERP_RE = /\$\{([A-Z][A-Z0-9_]*)/g;

/** 提取 example 中声明的变量名（含注释示例行）。 */
export function exampleKeys(content: string): Set<string> {
  return new Set([...content.matchAll(EXAMPLE_KEY_RE)].map((m) => m[1]));
}

/** 提取 compose 中被 `${...}` 插值引用的变量名。 */
export function composeInterpolatedKeys(content: string): Set<string> {
  return new Set([...content.matchAll(COMPOSE_INTERP_RE)].map((m) => m[1]));
}

/** 比对两侧，返回错误列表（空数组 = 通过）。 */
export function findInjectionGaps(
  exampleContent: string,
  composeContent: string,
  allowlist: Readonly<Record<string, string>> = NOT_INJECTED,
): string[] {
  const declared = exampleKeys(exampleContent);
  const injected = composeInterpolatedKeys(composeContent);
  // 零输入守卫：解析失效时「无违规」是假绿
  if (declared.size === 0 || injected.size === 0) {
    return ["未解析到任何变量：门禁可能已失效"];
  }
  const errors: string[] = [];
  for (const key of [...declared].sort()) {
    if (injected.has(key) || key in allowlist) continue;
    errors.push(`${key}：.env.prod.example 已声明，但 compose 未注入任何服务`);
  }
  // 白名单陈旧：变量已从 example 删除或已改为插值注入
  for (const key of Object.keys(allowlist).sort()) {
    if (!declared.has(key)) {
      errors.push(`${key}：白名单条目已不在 .env.prod.example 中，请移除`);
    } else if (injected.has(key)) {
      errors.push(`${key}：已被 compose 插值注入，请从白名单移除`);
    }
  }
  return errors;
}

/** 主流程：读取仓库文件并比对。 */
export async function checkProdEnvInjection(root = "."): Promise<string[]> {
  const example = await Deno.readTextFile(root + "/.env.prod.example");
  const compose = await Deno.readTextFile(root + "/docker-compose.prod.yml");
  return findInjectionGaps(example, compose);
}

if (import.meta.main) {
  const errors = await checkProdEnvInjection();
  if (errors.length > 0) {
    console.error("生产 env 注入一致性检查失败：");
    for (const e of errors) console.error("  - " + e);
    console.error(
      "修复：在 docker-compose.prod.yml 对应服务的 environment 中加入 " +
        "`KEY: ${KEY:-<默认>}`；若确实无需进容器，登记到 " +
        "scripts/check-prod-env-injection.ts 的 NOT_INJECTED 并写明原因。",
    );
    Deno.exit(1);
  }
  console.log("生产 env 注入一致性检查通过");
}
