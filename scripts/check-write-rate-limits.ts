/**
 * 写端点限流覆盖门禁（2026-09-12 架构评审 §4.6）。
 *
 * 背景：`dev-docs/engineering/write-rate-limit-matrix.md` 的覆盖面很好，但矩阵靠**人工
 * 维护**——新增写端点漏加限流没有任何自动发现机制（本次评审发现 12 个含写路由的文件
 * 完全没有限流证据，其中 9 个是文档"已知未覆盖"里说明过的）。
 *
 * 检查方式（文件级，刻意保守）：
 * - 扫描 `noj-core/src/domains/*\/routes/*.ts` 中的写方法路由（POST/PUT/PATCH/DELETE）；
 * - 文件内出现任一限流证据（`enforce*RateLimit` / `rateLimit(` / `RateLimitConfig` /
 *   `rate-limit` 引用）即视为已覆盖；
 * - 否则必须出现在下方 `ALLOWLIST`（附理由与状态）。
 *
 * 为什么是文件级而非逐路由：逐路由需要解析 handler 边界，容易误判；文件级 + 白名单
 * 足以拦住"新写路由文件完全没考虑限流"这一类主要漂移。
 *
 * 自检：扫描不到任何路由文件 / 解析不到任何写路由 → 判定门禁失效并失败。
 */

import { relative, resolve } from "node:path";
import { collectRouteFiles } from "./gen-route-catalog.ts";

export interface WriteRouteFile {
  file: string;
  writeRoutes: string[];
  hasRateLimitEvidence: boolean;
}

export type AllowlistStatus =
  /** 明确不需要限流（有文档依据） */
  | "exempt"
  /** 尚未限流，属于已知欠债（计数可见，便于逐步偿还） */
  | "pending";

/**
 * 白名单：已有写路由但未做限流的文件。
 *
 * `exempt` 的依据来自 `dev-docs/engineering/write-rate-limit-matrix.md`
 * 的「已知未覆盖/可接受」小节；`pending` 是本门禁新暴露出来的欠债。
 */
export const ALLOWLIST: Record<
  string,
  { status: AllowlistStatus; reason: string }
> = {
  // ── 管理后台写操作：权限 + 审计兜底，矩阵文档明确列为可接受 ──
  "noj-core/src/domains/admin/routes/catalog.ts": {
    status: "exempt",
    reason:
      "管理后台写操作：admin 权限 + 审计日志兜底（矩阵文档「已知未覆盖」）",
  },
  "noj-core/src/domains/admin/routes/community.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  "noj-core/src/domains/admin/routes/contest.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  "noj-core/src/domains/admin/routes/gateway.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  "noj-core/src/domains/admin/routes/identity.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  "noj-core/src/domains/admin/routes/submission.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  "noj-core/src/domains/admin/routes/background-tasks.ts": {
    status: "exempt",
    reason:
      "管理后台任务重试：admin 权限 + 审计日志兜底；任务状态转换本身幂等且不接受普通成员写入",
  },
  // ── 题目版本管理（2026-10-10）：管理端写操作，admin 权限 + 审计兜底 ──
  "noj-core/src/domains/admin/routes/submission-jobs.ts": {
    status: "exempt",
    reason:
      "管理后台批量重测受理/重试：admin 权限 + 审计日志兜底（矩阵文档「已知未覆盖」）",
  },
  "noj-core/src/domains/admin/routes/problem-versions.ts": {
    status: "exempt",
    reason:
      "管理后台版本策略/固定版本：admin 权限 + 审计日志兜底（矩阵文档「已知未覆盖」）",
  },
  // ── 题单/标签 CRUD：权限受限、频率低，矩阵文档列为可接受 ──
  "noj-core/src/modules/problems/routes/tags.ts": {
    status: "exempt",
    reason: "标签 CRUD：tag:manage 权限受限（矩阵文档「已知未覆盖」）",
  },
  "noj-core/src/modules/problems/routes/trainings.ts": {
    status: "exempt",
    reason: "题单 CRUD：权限受限、频率低（矩阵文档「已知未覆盖」）",
  },
  "noj-core/src/modules/problems/routes/domain-trainings.ts": {
    status: "exempt",
    reason:
      "域题单 CRUD：本域资源管理权限与审计，沿用题单低频管理豁免；不接受普通成员内容写入",
  },
  // ── 内部服务端点（P1d）：凭据保护、仅容器内 CLI 调用，不面向浏览器 ──
  "noj-core/src/modules/platform/system/routes/internal-drain.ts": {
    status: "exempt",
    reason:
      "内部维护/排空端点：Authorization Bearer NOJ_INTERNAL_SERVICE_TOKEN（timingSafeEqual）保护，" +
      "仅由容器内 maintain CLI / noj-cli 自动排空调用，不对浏览器或匿名开放；" +
      "对内部 wait 轮询做用户向限流会破坏排空语义",
  },
  // ── 2026-10-31 解析器修复后新进入检查的文件 ──────────────────────────
  // 这批文件此前因"路径写成局部常量/模板字符串"而完全没被解析（extracted=[]），
  // 门禁的"通过"只是因为它们没被检查。以下逐条说明真实处置，不编造覆盖。
  "noj-core/src/modules/communication/community/routes/domain-governance.ts": {
    status: "exempt",
    reason:
      "域社区治理：除 `/reports` 外的 8 条写路由都要求 community:moderate（域审核员/管理员），" +
      "属权限 + 审计兜底的管理操作，与 admin 写操作同口径；" +
      "`POST /reports` 本身由父路由 domain-community.ts 的 enforceReportRateLimit 覆盖（60s/30）",
  },
  "noj-core/src/modules/platform/gateway/routes/domain-llm.ts": {
    status: "exempt",
    reason: "域 LLM 配置：全部写路由要求 llm:manage（域管理员级），频率极低；" +
      "`providers/:id/test` 会发起真实上游请求，属人工排障动作，限流会误伤连续排查",
  },
  "noj-core/src/modules/problems/routes/domain-resource-management.ts": {
    status: "exempt",
    reason:
      "域题库资源管理：import 要求 problem:create、policy 要求 problem:policy，" +
      "均为域资源管理权限 + 审计记录，沿用题单/标签的低频管理豁免",
  },
};

/** 限流证据模式（文件级启发式：宁可宽松，避免"已限流却报错"的噪声）。 */
const RATE_LIMIT_RE =
  /enforce[A-Za-z]*RateLimit|hardeningRateLimit|RateLimitConfig|rateLimit|rate-limit/i;

/**
 * 写方法路由（接收者锚定 + 路径以 / 开头，与路由目录生成器同一口径）。
 *
 * **2026-10-31 修复**：此前的路径捕获组是 `["'`]([^"'`]+)["'`]`，只认**字符串字面量**
 * 路径。而域路由普遍用局部常量与模板字符串书写：
 *
 * ```ts
 * const path = "/domains/:slug/contests";
 * domainContestRouter.post(path, authMiddleware, ...);
 * domainContestRouter.patch(`${path}/:id`, ...);
 * ```
 *
 * 于是 `domain-contests.ts` 的 8 条写路由**一条都没被解析出来**（实测 `extracted: []`），
 * 文件因"没有写路由"直接跳过判定——不是"文件级判定太粗"，而是该文件根本没进入检查。
 * 现在额外接受三类路径表达式：
 *
 * 1. 标识符（局部常量，如 `path`）；
 * 2. 模板字符串（含 `${path}` 插值）；
 * 3. `标识符 + 字符串` 的简单拼接。
 *
 * 仍然要求"接收者锚定"，避免把 `c.get("userId")` 这类上下文读取误判为路由。
 */
const WRITE_ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\.(post|put|patch|delete)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*[,)]/g;

/**
 * 从文件内容中提取写路由路径。
 *
 * 模板字符串会保留 `${...}` 原样（例如 `POST ${path}/:id`），标识符路径会解析成
 * `@<identifier>` 形式——两者都不要求可读，只要求**能被识别出一条写路由**。
 * 局部常量的真实值由 `resolvePathConstants` 尽量回填，便于报错信息可读。
 */
export function extractWriteRoutes(text: string): string[] {
  const constants = collectPathConstants(text);
  const paths: string[] = [];
  for (const m of text.matchAll(WRITE_ROUTE_RE)) {
    const method = m[2].toUpperCase();
    const literal = m[3] ?? m[4];
    const template = m[5];
    const identifier = m[6];
    let path: string | null = null;
    if (literal !== undefined) path = literal;
    else if (template !== undefined) path = expandTemplate(template, constants);
    else if (identifier !== undefined) {
      path = constants.get(identifier) ?? `@${identifier}`;
    }
    if (path && (path.startsWith("/") || path.startsWith("@"))) {
      paths.push(`${method} ${path}`);
    }
  }
  return paths;
}

/**
 * 展开模板字符串里的常量插值（`${path}/:id` → `/domains/:slug/contests/:id`）。
 *
 * 未解析到的插值保留 `${name}` 原样：只要模板以已解析的常量开头，它仍然是一条
 * 可识别的写路由；无法判定前缀时返回 `@template` 占位而不是丢弃。
 */
function expandTemplate(
  template: string,
  constants: Map<string, string>,
): string {
  const expanded = template.replace(
    /\$\{([A-Za-z_$][\w$]*)\}/g,
    (whole, name: string) => constants.get(name) ?? whole,
  );
  if (expanded.startsWith("/")) return expanded;
  // 首个插值解析失败但后面还有路径片段：保留模板形态，仍视为一条写路由。
  return expanded.includes("/") ? `@${template}` : template;
}

/**
 * 收集文件内的路径常量（`const path = "/x"` / `const PREFIX = '/y'`）。
 *
 * 只用于把标识符还原成可读路径；解析不到时保留 `@name` 占位，仍然算"识别到写路由"。
 */
function collectPathConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  const re =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*(["'`])([^"'`]+)\2/g;
  for (const m of text.matchAll(re)) {
    if (m[3]?.startsWith("/")) constants.set(m[1], m[3]);
  }
  return constants;
}

/** 文件是否含限流证据。 */
export function hasRateLimitEvidence(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

export interface WriteRateLimitResult {
  errors: string[];
  stats: {
    scanned_files: number;
    write_routes: number;
    files_without_limits: number;
    pending_debt: number;
  };
}

/** 执行检查；root 默认为仓库根目录。 */
export async function checkWriteRateLimits(
  root = ".",
  options: { checkStaleAllowlist?: boolean } = {},
): Promise<WriteRateLimitResult> {
  const errors: string[] = [];
  const inspected: WriteRouteFile[] = [];
  // 白名单只对"真实仓库根"有意义；临时夹具目录（单测）不触发陈旧条目检查
  const checkStale = options.checkStaleAllowlist ?? root === ".";

  // 与路由目录共用元数据发现，迁移到 modules 后仍检查同一批实际路由。
  const files = collectRouteFiles(resolve(root));

  let writeRoutes = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    const routes = extractWriteRoutes(text);
    if (routes.length === 0) continue;
    writeRoutes += routes.length;
    inspected.push({
      file: relative(resolve(root), file),
      writeRoutes: routes,
      hasRateLimitEvidence: hasRateLimitEvidence(text),
    });
  }

  // ── 自检 ──
  if (files.length === 0) {
    errors.push("未扫描到任何路由文件（目录结构或过滤规则已失效）");
  }
  if (writeRoutes === 0) {
    errors.push("未解析到任何写路由（写路由正则已与代码写法脱节，门禁恒真）");
  }

  const withoutLimits = inspected.filter((f) => !f.hasRateLimitEvidence);
  let pendingDebt = 0;
  for (const entry of withoutLimits) {
    const allow = ALLOWLIST[entry.file];
    if (!allow) {
      errors.push(
        `${entry.file} 含 ${entry.writeRoutes.length} 个写路由但无任何限流证据` +
          `（如确不需要，请在 scripts/check-write-rate-limits.ts 的 ALLOWLIST 登记理由）`,
      );
      continue;
    }
    if (allow.status === "pending") pendingDebt++;
  }

  // 白名单陈旧检测：已加限流或文件消失的条目应被移除，避免白名单无限膨胀
  if (checkStale) {
    const withoutLimitsSet = new Set(withoutLimits.map((f) => f.file));
    for (const file of Object.keys(ALLOWLIST)) {
      if (!withoutLimitsSet.has(file)) {
        errors.push(
          `ALLOWLIST 中的 ${file} 已不再需要豁免（已加限流或文件已删除），请移除该条目`,
        );
      }
    }
  }

  return {
    errors,
    stats: {
      scanned_files: files.length,
      write_routes: writeRoutes,
      files_without_limits: withoutLimits.length,
      pending_debt: pendingDebt,
    },
  };
}

if (import.meta.main) {
  const { errors, stats } = await checkWriteRateLimits(".");
  if (errors.length > 0) {
    console.error("写端点限流覆盖检查失败：");
    for (const e of errors) console.error(`- ${e}`);
    Deno.exit(1);
  }
  console.log(
    `写端点限流覆盖检查通过（路由文件 ${stats.scanned_files} 个 / 写路由 ${stats.write_routes} 条 / ` +
      `未限流文件 ${stats.files_without_limits} 个全部已登记，其中待偿还欠债 ${stats.pending_debt} 个）`,
  );
}
