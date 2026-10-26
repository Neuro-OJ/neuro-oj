/**
 * deno.lock → package-lock.json（v3）转换器，供 osv-scanner 扫描 npm 依赖。
 *
 * 背景（issue #661）：osv-scanner 2.7.0（osv-scalibr 0.5.3）**没有 deno.lock
 * 提取器**，直接 `--lockfile=xxx/deno.lock` 会以 127 退出并打印
 * "could not determine extractor suitable to this file"——5 个 deno.lock 的
 * 依赖等于零扫描。本脚本把 deno.lock v5 的 `npm` 段（键为
 * `name@version[_peerSuffix]`）转成 package-lock v3，交给 osv-scanner 的
 * `javascript/packagelockjson` 提取器。
 *
 * 覆盖边界：只转换 npm 生态。jsr 包不在 npm 注册表、OSV 也没有对应 npm 记录，
 * 显式跳过并在输出中计数，避免"看起来扫了其实没扫"。
 *
 * 注意：osv-scanner 按**文件名**识别锁文件，输出必须命名为 `package-lock.json`
 * （放在各自模块目录下），否则会以 127 退出并提示无法确定提取器。
 *
 * 用法：
 *   deno run -A scripts/security/deno-lock-to-package-lock.ts \
 *     <deno.lock> <out-dir>/package-lock.json
 */

/** 单个 npm 包（name + 已剥离 peer 后缀的版本）。 */
export interface NpmPackage {
  name: string;
  version: string;
}

/** 转换结果统计。 */
export interface ConvertStats {
  /** 去重后的 npm 包数量。 */
  npm: number;
  /** 跳过的 jsr 包数量。 */
  jsr: number;
  /** 无法解析的 npm 键（正常情况下应为空）。 */
  skipped: string[];
}

/**
 * 解析 deno.lock 的 npm 键。
 *
 * 形如 `@scope/pkg@1.2.3`、`pkg@1.2.3_peer@4.5.6`；下划线之后是 Deno 记录的
 * peer 依赖后缀，不是版本的一部分。
 */
export function parseNpmKey(key: string): NpmPackage | null {
  // 从索引 1 开始找 @，跳过 scoped 包名开头的 @
  const at = key.indexOf("@", 1);
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const rawVersion = key.slice(at + 1);
  const peerSuffix = rawVersion.indexOf("_");
  const version = peerSuffix >= 0
    ? rawVersion.slice(0, peerSuffix)
    : rawVersion;
  if (!name || !version) return null;
  return { name, version };
}

/** 把 deno.lock 内容转换为 package-lock v3 对象。 */
export function convertDenoLock(
  lock: unknown,
  label = "deno-lock",
): { lockfile: Record<string, unknown>; stats: ConvertStats } {
  if (lock === null || typeof lock !== "object") {
    throw new Error("deno.lock 不是 JSON 对象");
  }
  const record = lock as Record<string, unknown>;
  const npm = record.npm;
  if (npm !== undefined && (npm === null || typeof npm !== "object")) {
    throw new Error("deno.lock 的 npm 段格式异常");
  }
  const npmEntries = Object.keys((npm ?? {}) as Record<string, unknown>);

  const seen = new Set<string>();
  const packages: Record<string, unknown> = {};
  const skipped: string[] = [];
  const npmMap = (npm ?? {}) as Record<string, unknown>;
  for (const key of npmEntries) {
    const parsed = parseNpmKey(key);
    if (!parsed) {
      skipped.push(key);
      continue;
    }
    const id = `${parsed.name}@${parsed.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const meta = npmMap[key];
    const detail = meta && typeof meta === "object"
      ? meta as Record<string, unknown>
      : {};
    // `resolved` 是 osv-scanner 判定 npm 生态的必需字段：缺省时条目会被
    // 静默跳过（实测 lodash 4.17.20 不报任何漏洞）。deno.lock 只在非默认
    // registry 时记录 tarball，其余按 npm 官方 registry 的固定布局补全。
    const entry: Record<string, unknown> = {
      name: parsed.name,
      version: parsed.version,
    };
    entry.resolved = typeof detail.tarball === "string"
      ? detail.tarball
      : `https://registry.npmjs.org/${parsed.name}/-/${
        parsed.name.split("/").pop()
      }-${parsed.version}.tgz`;
    if (typeof detail.integrity === "string") {
      entry.integrity = detail.integrity;
    }
    // 键路径保持唯一：同名多版本不会互相覆盖；显式 name 让提取器无需解析路径。
    packages[`node_modules/.deno/${id}/node_modules/${parsed.name}`] = entry;
  }

  const lockfile = {
    name: label,
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: label, version: "0.0.0" },
      ...packages,
    },
  };
  const jsr = record.jsr;
  return {
    lockfile,
    stats: {
      npm: seen.size,
      jsr: jsr && typeof jsr === "object" ? Object.keys(jsr).length : 0,
      skipped,
    },
  };
}

if (import.meta.main) {
  const [input, output] = Deno.args;
  if (!input || !output) {
    console.error(
      "用法: deno run -A scripts/security/deno-lock-to-package-lock.ts <deno.lock> <out-dir>/package-lock.json",
    );
    Deno.exit(2);
  }
  const lock = JSON.parse(await Deno.readTextFile(input));
  const label = input.replace(/\/deno\.lock$/, "").split("/").pop() ??
    "deno-lock";
  const { lockfile, stats } = convertDenoLock(lock, `deno-lock-${label}`);
  if (stats.skipped.length > 0) {
    console.error(
      `无法解析的 npm 键（${stats.skipped.length}）：${
        stats.skipped.join(", ")
      }`,
    );
    Deno.exit(1);
  }
  const dir = output.slice(0, output.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(output, JSON.stringify(lockfile, null, 2) + "\n");
  console.log(
    `${input}: npm ${stats.npm} 个包 → ${output}（跳过 jsr ${stats.jsr} 个）`,
  );
}
