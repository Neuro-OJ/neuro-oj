/**
 * 构建身份（版本 / commit / 构建时间）的单一真相源。
 *
 * 背景：此前版本号散落在多处硬编码（`health.ts` 三处、`scripts/noj.ts` 一处都写着
 * 早已过期的 `0.9.5`），既没有事实源也无法回答"线上跑的是哪次提交"。本模块提供
 * 唯一入口，供健康探针、公开站点元信息与开发 CLI 共用。
 *
 * 取值优先级：
 * 1. 镜像构建期注入的 ENV（`release.yml` build-arg → Dockerfile `ENV`）——生产路径，
 *    因此任何部署形态（源码/容器/编译产物）都能自描述身份；
 * 2. 开发回退：本模块 `deno.json` 的 `version`、本地 `git rev-parse --short HEAD`
 *    （工作区有改动则缀 `-dirty`）；`builtAt` 取**进程启动时刻**——dev 没有"构建"
 *    这一步，用启动时刻才能回答"我重启过没有"；
 * 3. 两者皆无 → `unknown`（不抛错、不阻塞启动）。
 *
 * 只读常量：模块加载时求值一次，不随请求变化，也不属于"进程内可变状态"。
 */

/** ENV 未提供版本时的占位值（显示层据此决定如何降级渲染）。 */
export const UNKNOWN_VERSION = "unknown";

/** 构建身份三元组。 */
export interface BuildInfo {
  /** 版本号（如 `0.10.1-beta.2`）；无法确定时为 {@link UNKNOWN_VERSION}。 */
  version: string;
  /** 短 commit hash（可带 `-dirty` 后缀）；无法确定时为 null。 */
  commit: string | null;
  /** 构建时刻（ISO 8601 UTC）；开发环境为进程启动时刻；无法确定时为 null。 */
  builtAt: string | null;
}

/** 进程启动时刻：开发环境下作为 `builtAt` 的替代值。 */
const PROCESS_STARTED_AT = new Date().toISOString();

/**
 * 执行 git 命令并返回标准输出（失败/超时/无 git 一律返回 null）。
 *
 * 仅在未注入构建期 ENV 时调用（即开发环境），生产镜像内不执行外部命令。
 */
function tryGit(args: string[]): string | null {
  try {
    const result = new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * 读取本模块 `deno.json` 的 `version` 字段（开发环境回退）。
 *
 * 编译为单二进制后 `import.meta.url` 指向临时解包目录、镜像内也没有 deno.json，
 * 读取失败即返回 null——生产环境的值来自 ENV，不依赖这条路径。
 */
function tryManifestVersion(): string | null {
  try {
    const raw = Deno.readTextFileSync(
      new URL("../../../deno.json", import.meta.url),
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/** 解析构建身份（ENV → 开发回退 → unknown）。 */
function resolveBuildInfo(): BuildInfo {
  const envVersion = Deno.env.get("NOJ_BUILD_VERSION")?.trim();
  const envCommit = Deno.env.get("NOJ_BUILD_COMMIT")?.trim();
  const envBuiltAt = Deno.env.get("NOJ_BUILD_TIME")?.trim();

  const version = envVersion || tryManifestVersion() || UNKNOWN_VERSION;

  // commit：注入值优先；否则开发环境用本地 git（工作区脏则标注）
  let commit = envCommit || null;
  if (!commit) {
    const head = tryGit(["rev-parse", "--short", "HEAD"]);
    if (head) {
      const dirty = (tryGit(["status", "--porcelain"]) ?? "").length > 0;
      commit = dirty ? `${head}-dirty` : head;
    }
  }

  return Object.freeze({
    version,
    commit,
    builtAt: envBuiltAt || PROCESS_STARTED_AT,
  });
}

/** 本进程的构建身份（模块加载时求值一次）。 */
const BUILD_INFO: BuildInfo = resolveBuildInfo();

/**
 * 获取本进程的构建身份（版本 / commit / 构建时间）。
 *
 * 供健康探针（`/health*`）、公开站点元信息（`/api/v1/site/meta`）与开发 CLI 共用，
 * 保证任何对外暴露的版本号都来自同一处，不再出现"探针说 A、页脚说 B"。
 */
export function getBuildInfo(): BuildInfo {
  return BUILD_INFO;
}
