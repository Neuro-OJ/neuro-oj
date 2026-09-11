/**
 * 配置读取点静态校验（issue #500）。
 *
 * 背景：`settings-registry.ts` 被声明为配置的「单一事实源」，但此前的
 * `check-env.ts` 只校验「键的声明是否对得上」（注册表 ↔ `.env.example`），
 * **不校验声明的键是否真的有人读**。于是任何人新增一个注册表条目、只在后台展示
 * 而不接线，就能长期无人察觉——`homepage_banner` 自 issue #99 起就这样存在至今。
 *
 * 本脚本补上两条方向相反的检查：
 *
 * 1. **正向（死键）**：注册表里可见的键必须存在真实读取点。
 *    - runtime 键：`getSetting("<key>")` / `settingInt` / `settingBool` / `getSettingOrThrow`
 *    - bootstrap 键：同上（走 env 快照），或 `Deno.env.get("<envKey>")` / `envInt` / `envBool`
 *    - 动态构造的键（模板拼接 env 名）通过「前缀声明」纳入校验，见下。
 * 2. **反向（盲区）**：代码里真实读取的 env 必须在某份声明（core 注册表 /
 *    网关注册表）中登记，或在显式豁免清单中——否则后台不可见、check-env 覆盖不到。
 *
 * 跨服务原则（issue #497 决策）：**谁读谁声明**。
 * - noj-core 消费的键 → `noj-core/src/shared/config/settings-registry.ts`
 * - noj-llm-gateway 消费的键 → `noj-llm-gateway/src/config-registry.ts`
 * 两份声明都由本脚本校验，因此不会出现「登记在 A、实际由 B 读」的误导。
 *
 * 豁免与动态声明的写法（都要求写明理由，避免变成静默忽略）：
 * - 文件级：在任意位置写 `// config-usage: exempt-file <理由>`
 *   （仅对反向检查生效，表示该文件的 env 读取不属于配置面，如测试/工具脚本）
 * - 键级：在注册表条目上写 `// config-usage: exempt <理由>`
 * - 动态前缀：注册表条目带 `dynamicPrefix`，表示该键由前缀模板生成读取；
 *   脚本要求源码中存在该前缀字面量，并由各服务的枚举测试保证集合一致
 *   （见 `noj-llm-gateway/tests/limits_test.ts` 的配额 env 枚举断言）。
 *
 * 用法：
 * ```bash
 * cd noj-core && deno task check:config-usage
 * ```
 *
 * 失败信息给出键名、scope，以及「要么接线、要么删除、要么显式豁免」的处理指引。
 */

import { CONFIG_DEFINITIONS } from "../src/shared/config/settings-registry.ts";
import type { SettingDefinition } from "../src/shared/config/settings-registry.ts";

/** 仓库根（本脚本位于 noj-core/scripts/） */
const REPO_ROOT = new URL("../../", import.meta.url);
const CORE_ROOT = new URL("../", import.meta.url);

export interface UsageFinding {
  key: string;
  /** 校验方向：dead=runtime/bootstrap 键无读取点；blind=代码读但未登记 */
  kind: "dead" | "blind";
  reason: string;
  hint: string;
}

/**
 * 反向检查用的 env 读取形态。
 *
 * 正向（死键）判定不枚举访问器，而采用「键名作为字符串字面量出现在消费文件中」
 * ——实测发现访问器名匹配会漏掉三类真实读取：映射表、本地封装（`num(...)`）、
 * 本地 env 封装（`readPositiveIntEnv(...)`）。见 `hasLiteralReference`。
 */
const ENV_ACCESSORS = ["Deno.env.get", "envInt", "envBool"] as const;

/**
 * 不算「消费」的文件：仅做注册表声明、校验、快照、模板，或通用 KV 编辑器。
 * 这些路径里的字符串出现不代表行为被配置驱动。
 */
const NON_CONSUMER_PATTERNS: RegExp[] = [
  /shared\/config\/settings-registry\.ts$/,
  /shared\/config\/production-config\.ts$/,
  /scripts\/check-env\.ts$/,
  /scripts\/check-config-usage\.ts$/,
  /scripts\/test-parallel\.ts$/,
  /domains\/system\/services\/env-snapshot\.ts$/,
  // 设置 KV 存储自身的实现与其**校验分支**（如 `key === "smtp_from"` 只做 email
  // 格式校验，不代表该键被消费）。审计口径明确把这类「能存/能校验」排除在消费之外，
  // 否则 smtp_from 这类死键会被自己的校验分支掩盖（实测漏报）。
  /domains\/system\/services\/system-settings\.ts$/,
  // 管理后台通用设置页：对任何键一视同仁，不构成消费
  /noj-ui\/pages\/admin\/settings\.vue$/,
];

/** 测试文件一律不算消费 */
function isTestFile(path: string): boolean {
  return /(^|\/)(tests?)\//.test(path) || /_test\.ts$/.test(path) ||
    /\.(test|spec)\.ts$/.test(path);
}

/** 递归收集源文件（只取 .ts/.vue），跳过 node_modules 与构建产物 */
async function collectFiles(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (
        ["node_modules", ".git", ".output", ".deno", "dist", "coverage"]
          .includes(entry.name)
      ) {
        continue;
      }
      await collectFiles(full, out);
    } else if (/\.(ts|vue)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface SourceFile {
  /** 相对仓库根的路径（用于排除规则与报错定位） */
  path: string;
  text: string;
}

async function loadSources(roots: URL[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const root of roots) {
    const abs = root.pathname.replace(/\/$/, "");
    let collected: string[] = [];
    try {
      collected = await collectFiles(abs);
    } catch {
      // 该服务目录不存在（如未初始化的可选模块）时跳过
      continue;
    }
    for (const full of collected) {
      const rel = full.replace(REPO_ROOT.pathname, "").replace(/^\//, "");
      files.push({ path: rel, text: await Deno.readTextFile(full) });
    }
  }
  return files;
}

/** 文件是否声明了「本文件的 env 读取与配置面无关」 */
function hasExemptFileAnnotation(text: string): boolean {
  return /\/\/\s*config-usage:\s*exempt-file\b/.test(text);
}

/** 注册表条目是否声明了键级豁免 */
function entryExemption(def: SettingDefinition): string | null {
  const comment = (def as unknown as { description?: string }).description ??
    "";
  const m = comment.match(/config-usage:\s*exempt\s+(.+)/);
  return m ? m[1]!.trim() : null;
}

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 去掉注释后再匹配，避免把「文档/注释里提到某个键」误判为消费。
 * 只处理行注释与块注释；不做完整词法分析（字符串里含 `//` 的极端情形
 * 会少识别一个读点，宁可漏报也不误报——漏报由反向检查与人工评审兜底）。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 键名是否作为字符串字面量出现在文本中（去掉注释后） */
function hasLiteralReference(text: string, name: string): boolean {
  const re = new RegExp(`["'\`]${escapeRe(name)}["'\`]`);
  return re.test(text);
}

/**
 * 收集源码中静态读取的全部 env 名。
 *
 * 只扫描**消费文件**（已排除测试与注册表/校验/快照等非消费路径，并已剥离注释）：
 * - 测试文件里的 `Deno.env.get("NOJ_RUN_PERF")` 是测试开关，不是产品配置面；
 * - 文档注释里举例的 `Deno.env.get("NAME")` 更不能算读取点。
 * 二者都曾在实测中造成误报。
 */
function collectEnvReads(files: SourceFile[]): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  const add = (name: string, path: string) => {
    const arr = reads.get(name) ?? [];
    arr.push(path);
    reads.set(name, arr);
  };

  for (const f of files) {
    for (const acc of ENV_ACCESSORS) {
      const re = new RegExp(
        `${escapeRe(acc)}\\(\\s*["'\`]([A-Z][A-Z0-9_]*)["'\`]`,
        "g",
      );
      for (const m of f.text.matchAll(re)) add(m[1]!, f.path);
    }
    // 网关风格：`env.NOJ_LLM_XXX`（loadConfig 的注入参数）
    for (const m of f.text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      add(m[1]!, f.path);
    }
  }
  return reads;
}

/**
 * 校验注册表与源码读取点的一致性。
 *
 * @param defs core 注册表条目
 * @param gatewayDefs 网关侧声明条目
 * @param files 参与检查的源码文件
 * @returns 发现的问题（空数组表示通过）
 */
export function inspectConfigUsage(
  defs: readonly SettingDefinition[],
  gatewayDefs: readonly GatewayEnvDefinition[],
  files: SourceFile[],
): UsageFinding[] {
  const findings: UsageFinding[] = [];
  const consumerFiles = files.filter(
    (f) =>
      !isTestFile(f.path) &&
      !NON_CONSUMER_PATTERNS.some((re) => re.test(f.path)) &&
      // 文件级豁免注解：声明该文件的 env 读取与配置面无关
      // （必须在剥离注释**之前**判定，否则注解本身会被删掉）
      !hasExemptFileAnnotation(f.text),
  ).map((f) => ({ path: f.path, text: stripComments(f.text) }));

  // ── 正向：每个可见键都要有读取点 ──
  for (const def of defs) {
    if (def.visible === false) continue;
    const exempt = entryExemption(def);
    if (exempt) continue;

    const names = [def.key, def.envKey, def.envFallback].filter(
      (n): n is string => Boolean(n),
    );
    // 判定：键名作为字符串字面量出现在消费文件中（含访问器调用与映射表等间接形态）
    const found = consumerFiles.some((f) =>
      names.some((n) => hasLiteralReference(f.text, n))
    );
    if (found) continue;

    // 动态构造的键：只要有前缀字面量即视为已接线（集合一致性由枚举测试保证）
    const prefix = (def as unknown as { dynamicPrefix?: string })
      .dynamicPrefix;
    if (prefix) {
      const hasPrefix = consumerFiles.some((f) => f.text.includes(prefix));
      if (hasPrefix) continue;
    }

    findings.push({
      key: def.key,
      kind: "dead",
      reason:
        `${def.scope} 键在 noj-core / noj-ui 中没有任何读取点（只登记、不消费）`,
      hint:
        "要么接线（真正读取该键）、要么从注册表删除、要么用 `// config-usage: exempt <理由>` 显式豁免",
    });
  }

  // ── 正向：网关侧声明同样要有读取点 ──
  for (const def of gatewayDefs) {
    if (def.readMode === "dynamic") {
      // 动态前缀：源码里应存在前缀字面量；集合一致性由网关枚举测试保证
      if (
        def.dynamicPrefix &&
        consumerFiles.some((f) => f.text.includes(def.dynamicPrefix!))
      ) {
        continue;
      }
    }
    if (consumerFiles.some((f) => hasLiteralReference(f.text, def.key))) {
      continue;
    }
    findings.push({
      key: def.key,
      kind: "dead",
      reason: "网关声明的 env 在 noj-llm-gateway 中没有任何读取点",
      hint: "要么接线、要么从网关声明删除、要么显式豁免",
    });
  }

  // ── 反向：代码读到的 env 必须有声明 ──
  const declared = new Set<string>();
  for (const def of defs) {
    if (def.envKey) declared.add(def.envKey);
    if (def.envFallback) declared.add(def.envFallback);
    declared.add(def.key);
  }
  for (const def of gatewayDefs) declared.add(def.key);

  const reads = collectEnvReads(consumerFiles);
  for (const [name, paths] of reads) {
    if (declared.has(name) || REVERSE_EXEMPT.has(name)) continue;
    // 前缀声明的动态键：形如 NOJ_LLM_DEFAULT_* 由网关声明覆盖
    const coveredByPrefix = gatewayDefs.some(
      (d) => d.dynamicPrefix && name.startsWith(d.dynamicPrefix),
    );
    if (coveredByPrefix) continue;
    findings.push({
      key: name,
      kind: "blind",
      reason: `代码读取但未在任何配置声明中登记（首次出现于 ${paths[0]}）`,
      hint:
        "登记入对应服务的配置声明（谁读谁声明），或在 REVERSE_EXEMPT / exempt-file 中显式豁免",
    });
  }

  return findings;
}

/** 网关侧 env 声明条目（结构镜像 core 注册表的最小集） */
export interface GatewayEnvDefinition {
  key: string;
  description: string;
  isSecret: boolean;
  /** static=源码字面量读取；dynamic=由前缀模板生成读取 */
  readMode: "static" | "dynamic";
  /** dynamic 时的前缀，供本脚本与枚举测试核对 */
  dynamicPrefix?: string;
}

/**
 * 反向检查豁免清单：工具链 / 测试 / 编排专用 env。
 *
 * 这些不属于「产品配置面」，无需在注册表中登记；但必须是**显式**清单，
 * 避免长期的「未登记」状态掩盖真正遗漏。
 */
export const REVERSE_EXEMPT = new Set([
  // 部署编排（compose/脚本注入，非应用读取）
  "NOJ_VERSION",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "REDIS_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "NODE_ENV",
  "NUXT_API_BASE",
  "NUXT_NOJ_ENV",
  "NUXT_ALLOW_INSECURE_HTTP",
  // 开发/测试工具链
  "NOJ_PROJECT_ROOT",
  "NOJ_BACKUP_PASSPHRASE_FILE",
  "NOJ_RUN_BROWSER_E2E",
  "NOJ_RUN_E2E",
  "E2E_BASE_URL",
  "E2E_UI_URL",
  "E2E_ADMIN_EMAIL",
  "E2E_ADMIN_PASS",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "TEST_SCHEMA",
  "BCRYPT_SALT_ROUNDS",
  // 网关自身的非配额配置（由 loadConfig 读取，见网关 .env.example）
  "NOJ_LLM_PORT",
  "NOJ_LLM_LOG_LEVEL",
  "NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE",
  "NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE",
  "NOJ_LLM_SERVICE_TOKEN",
  "NOJ_LLM_STORE_KEY",
  "NOJ_LLM_DATABASE_URL",
  "NOJ_LLM_REDIS_URL",
  "NOJ_LLM_MAX_CALLS_PER_MINUTE",
  "NOJ_LLM_MAX_TOKENS_PER_MINUTE",
]);

/** 默认扫描范围：core + noj-ui + 网关 */
export async function defaultSourceFiles(): Promise<SourceFile[]> {
  return await loadSources([
    new URL("src/", CORE_ROOT),
    new URL("noj-ui/", REPO_ROOT),
    new URL("noj-llm-gateway/src/", REPO_ROOT),
  ]);
}

if (import.meta.main) {
  const { GATEWAY_CONFIG_DEFINITIONS } = await import(
    "../../noj-llm-gateway/src/config-registry.ts"
  );
  const files = await defaultSourceFiles();
  const findings = inspectConfigUsage(
    CONFIG_DEFINITIONS,
    GATEWAY_CONFIG_DEFINITIONS,
    files,
  );

  if (findings.length === 0) {
    console.log(
      `[check:config-usage] 通过：${CONFIG_DEFINITIONS.length} 个 core 注册表键 + ` +
        `${GATEWAY_CONFIG_DEFINITIONS.length} 个网关声明键均有读取点，` +
        `未发现未登记 env`,
    );
    Deno.exit(0);
  }

  const dead = findings.filter((f) => f.kind === "dead");
  const blind = findings.filter((f) => f.kind === "blind");
  console.error(
    `[check:config-usage] 发现 ${findings.length} 个问题：` +
      `死键 ${dead.length} / 未登记 ${blind.length}\n`,
  );
  for (const f of findings) {
    const tag = f.kind === "dead" ? "死键" : "未登记";
    console.error(`  [${tag}] ${f.key}`);
    console.error(`      ${f.reason}`);
    console.error(`      → ${f.hint}\n`);
  }
  Deno.exit(1);
}
