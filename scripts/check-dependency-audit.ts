/**
 * 依赖安全审计门禁（2026-11-02 rc/v0.11 审计 F7）。
 *
 * 为什么不用 `deno audit --frozen-lockfile`：
 * `noj-ui/.npmrc` 把 registry 固定为镜像源，锁文件因此记录了**镜像的 tarball
 * 原点**；一旦换用官方 registry（CI 与审计服务的默认），Deno 会因 origin 不匹配
 * 直接拒绝读取锁文件（实测报 “does not match the expected registry origin”），
 * 而 `--no-lock` 又会跳过审计返回“无漏洞”。两种模式都无法回答
 * “**我们锁定的这些版本**有没有已知公告”。
 *
 * 本门禁因此自己完成审计：
 * 1. 解析各模块 `deno.lock` 的 `npm` 段，得到**锁定的精确版本**；
 * 2. 调 npm registry 的 bulk advisory 接口（`/-/npm/v1/security/advisories/bulk`），
 *    它是 npm audit 使用的同一数据源，与 tarball 原点无关；
 * 3. 命中项按 `scripts/advisory-ignore.json` 判定：已登记的按登记范围放行，
 *    未登记的按严重级别失败（默认 `critical` 阻断，可 `--level=high` 收紧）。
 *    high/moderate 全部打印，未登记项保持可见——审计的判断是“包级告警不等于
 *    可利用漏洞”，阻断级别只决定“哪一档必须先有书面结论”。
 *
 * 忽略清单必须写明**范围与理由与复核期限**：审计报告的判断是“不要把包级告警
 * 直接当成可利用漏洞”，因此每条忽略都要注明可达性结论（runtime / build-only）
 * 或“上游尚无修复版本”。
 */

/** 被审计的模块（锁文件相对仓库根的路径）。 */
export const AUDITED_MODULES: ReadonlyArray<{ name: string; lock: string }> = [
  { name: "noj-core", lock: "noj-core/deno.lock" },
  { name: "noj-ui", lock: "noj-ui/deno.lock" },
  { name: "noj-cli", lock: "noj-cli/deno.lock" },
  { name: "noj-llm-gateway", lock: "noj-llm-gateway/deno.lock" },
];

/** 严重级别排序（阻断判定用）。 */
const SEVERITY_ORDER = ["low", "moderate", "high", "critical"] as const;
export type Severity = typeof SEVERITY_ORDER[number];

/** 一条忽略登记。 */
export interface AdvisoryIgnoreEntry {
  /** GHSA/CVE 标识；`*` 表示该包所有公告（需极强理由）。 */
  advisory: string;
  /** 包名。 */
  package: string;
  /** 适用范围：runtime（进入分发产物）或 build（仅构建/测试工具链）。 */
  scope: "runtime" | "build";
  /** 可达性结论与理由。 */
  reason: string;
  /** 复核期限（YYYY-MM-DD）；过期后该条自动失效并重新阻断。 */
  review_by: string;
}

/** npm bulk advisory 响应结构（只取用到的字段）。 */
interface BulkAdvisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
  name: string;
}

/** 锁定版本映射：包名 → 版本集合。 */
export function lockedVersions(lockJson: unknown): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const npm = (lockJson as { npm?: Record<string, unknown> }).npm ?? {};
  for (const specifier of Object.keys(npm)) {
    // 形如 `@scope/name@1.2.3` 或 `name@1.2.3_peer@4.5.6`：
    // 版本段以 `_` 分隔 peer 解析后缀，peer 里可能还有 `@`，因此按第一个 `_` 切。
    // 先切掉 peer 解析后缀（`_peer@x`），再取最后一个 `@` 作为 name/version 分隔
    const head = specifier.split("_")[0]!;
    const at = head.lastIndexOf("@");
    if (at <= 0) continue;
    const name = head.slice(0, at);
    const version = head.slice(at + 1);
    const set = versions.get(name) ?? new Set<string>();
    set.add(version);
    versions.set(name, set);
  }
  return versions;
}

/** 构造 bulk 请求体（包名 → 版本数组）。 */
export function bulkRequestBody(
  versions: Map<string, Set<string>>,
): Record<string, string[]> {
  const body: Record<string, string[]> = {};
  for (const [name, set] of versions) body[name] = [...set];
  return body;
}

/** 查询 bulk 公告（可注入 fetch 便于自测）。 */
export async function fetchAdvisories(
  body: Record<string, string[]>,
  deps: { fetch: typeof fetch; registry?: string } = { fetch },
): Promise<Record<string, BulkAdvisory[]>> {
  const registry = (deps.registry ?? "https://registry.npmjs.org").replace(
    /\/+$/,
    "",
  );
  const res = await deps.fetch(
    `${registry}/-/npm/v1/security/advisories/bulk`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `公告接口返回 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`,
    );
  }
  return await res.json() as Record<string, BulkAdvisory[]>;
}

/** 判断某条告警是否被忽略清单覆盖（且未过期）。 */
export function isIgnored(
  moduleName: string,
  packageName: string,
  advisory: BulkAdvisory,
  ignore: ReadonlyArray<AdvisoryIgnoreEntry>,
  today = new Date(),
): AdvisoryIgnoreEntry | null {
  const iso = today.toISOString().slice(0, 10);
  for (const entry of ignore) {
    // 按**被查询的包名**匹配：bulk 响应里的 `name` 可能是缺陷所在的上游包
    // （例如 vite 的 launch-editor 告警），用它匹配会漏掉登记项。
    if (entry.package !== packageName) continue;
    if (entry.advisory !== "*" && !advisory.url.includes(entry.advisory)) {
      continue;
    }
    if (entry.review_by < iso) continue; // 已过期：不再覆盖
    void moduleName;
    return entry;
  }
  return null;
}

/** 单条告警的判定结果。 */
export interface AuditFinding {
  module: string;
  package: string;
  severity: Severity;
  advisory: string;
  title: string;
  ignored: boolean;
  reason?: string;
}

/** 汇总审计结果。 */
export interface DependencyAuditResult {
  findings: AuditFinding[];
  /** 达到阻断级别的未忽略告警。 */
  blocking: AuditFinding[];
  modulesAudited: number;
}

/** 读取忽略清单。 */
export function loadIgnoreList(path: string): AdvisoryIgnoreEntry[] {
  const raw = Deno.readTextFileSync(path);
  const parsed = JSON.parse(raw) as { advisories?: AdvisoryIgnoreEntry[] };
  return parsed.advisories ?? [];
}

/**
 * 执行审计。
 *
 * @param root 仓库根
 * @param options 注入点（测试用）+ 阻断级别
 */
export async function auditDependencies(
  root = ".",
  options: {
    fetch?: typeof fetch;
    level?: Severity;
    today?: Date;
  } = {},
): Promise<DependencyAuditResult> {
  const level = options.level ?? "critical";
  const threshold = SEVERITY_ORDER.indexOf(level);
  const ignore = loadIgnoreList(`${root}/scripts/advisory-ignore.json`);
  const findings: AuditFinding[] = [];
  let modulesAudited = 0;
  for (const module of AUDITED_MODULES) {
    let lockJson: unknown;
    try {
      lockJson = JSON.parse(Deno.readTextFileSync(`${root}/${module.lock}`));
    } catch {
      continue; // 模块没有锁文件（例如被裁剪的检出）时跳过
    }
    modulesAudited += 1;
    const versions = lockedVersions(lockJson);
    const advisories = await fetchAdvisories(bulkRequestBody(versions), {
      fetch: options.fetch ?? fetch,
    });
    for (const [pkg, list] of Object.entries(advisories)) {
      for (const advisory of list) {
        const entry = isIgnored(
          module.name,
          pkg,
          advisory,
          ignore,
          options.today ?? new Date(),
        );
        findings.push({
          module: module.name,
          package: pkg,
          severity: advisory.severity,
          advisory: advisory.url,
          title: advisory.title,
          ignored: entry !== null,
          reason: entry?.reason,
        });
      }
    }
  }
  const blocking = findings.filter((finding) =>
    !finding.ignored &&
    SEVERITY_ORDER.indexOf(finding.severity) >= threshold
  );
  return { findings, blocking, modulesAudited };
}

if (import.meta.main) {
  const levelArg = Deno.args.find((arg) => arg.startsWith("--level="));
  const level = (levelArg?.split("=")[1] ?? "critical") as Severity;
  const result = await auditDependencies(".", { level });
  const ignored = result.findings.filter((finding) => finding.ignored);
  console.log(
    `依赖审计：${result.modulesAudited} 个模块，命中 ${result.findings.length} 条，` +
      `忽略清单覆盖 ${ignored.length} 条，阻断级别 ${level}`,
  );
  for (const finding of result.findings.filter((f) => !f.ignored)) {
    console.log(
      `  ${finding.module} ${finding.package} [${finding.severity}] ${finding.advisory} — ${finding.title}`,
    );
  }
  if (result.blocking.length > 0) {
    console.error(
      `依赖审计失败：${result.blocking.length} 条未登记的 ${level} 及以上告警。` +
        `修复依赖，或在 scripts/advisory-ignore.json 登记可达性结论与复核期限。`,
    );
    Deno.exit(1);
  }
  console.log("依赖审计通过");
}
