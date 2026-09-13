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
  "noj-core/src/domains/admin/routes/system.ts": {
    status: "exempt",
    reason: "管理后台写操作：admin 权限 + 审计日志兜底",
  },
  // ── 题单/标签 CRUD：权限受限、频率低，矩阵文档列为可接受 ──
  "noj-core/src/domains/catalog/routes/tags.ts": {
    status: "exempt",
    reason: "标签 CRUD：tag:manage 权限受限（矩阵文档「已知未覆盖」）",
  },
  "noj-core/src/domains/catalog/routes/trainings.ts": {
    status: "exempt",
    reason: "题单 CRUD：权限受限、频率低（矩阵文档「已知未覆盖」）",
  },
  // ── 本次新暴露、尚未限流（欠债，保持可见）──
  "noj-core/src/domains/identity/routes/checkin.ts": {
    status: "pending",
    reason:
      "每日签到本身按天幂等；但写路由无任何限流，建议补 IP 限流或明确豁免",
  },
  "noj-core/src/domains/identity/routes/users.ts": {
    status: "pending",
    reason: "资料修改/注销账号等写路由无限流；注销为高价值操作，建议补限流",
  },
  "noj-core/src/domains/system/routes/email-delivery.ts": {
    status: "pending",
    reason: "邮件投递回执写路由无限流，需确认是否外部可达",
  },
};

/** 限流证据模式（文件级启发式：宁可宽松，避免"已限流却报错"的噪声）。 */
const RATE_LIMIT_RE =
  /enforce[A-Za-z]*RateLimit|hardeningRateLimit|RateLimitConfig|rateLimit|rate-limit/i;

/** 写方法路由（接收者锚定 + 路径以 / 开头，与路由目录生成器同一口径）。 */
const WRITE_ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

/** 从文件内容中提取写路由路径。 */
export function extractWriteRoutes(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(WRITE_ROUTE_RE)) {
    if (m[3]?.startsWith("/")) paths.push(`${m[2].toUpperCase()} ${m[3]}`);
  }
  return paths;
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

  const domainsDir = `${root}/noj-core/src/domains`;
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    // Deno.readDir 惰性迭代：目录不存在时错误在 for await 处抛出
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "tests") continue;
        await walk(path);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        path.includes("/routes/") && !path.endsWith("/index.ts")
      ) {
        files.push(path);
      }
    }
  }
  await walk(domainsDir);
  if (files.length === 0 && root === ".") {
    return {
      errors: [`无法读取路由目录 ${domainsDir}（目录结构或过滤规则已失效）`],
      stats: {
        scanned_files: 0,
        write_routes: 0,
        files_without_limits: 0,
        pending_debt: 0,
      },
    };
  }

  let writeRoutes = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    const routes = extractWriteRoutes(text);
    if (routes.length === 0) continue;
    writeRoutes += routes.length;
    inspected.push({
      file: file.replace(/^\.\//, ""),
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
