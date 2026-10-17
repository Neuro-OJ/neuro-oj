/**
 * 模块版本一致性门禁（Issue #658，2026-10-17）。
 *
 * 背景：仓库有 7 个模块各自在自己的清单里声明 `version`（Deno 的 `deno.json`、
 * Node 的 `package.json`、Rust 的 `Cargo.toml`）。它们没有任何同步机制，实测
 * `noj-tests` 已漂移到 `0.9.5`，其余 6 个是 `0.10.5`——`/api/v1/site/meta`
 * 的构建身份、发布说明与用户看到的版本号因此各说各话，且**没有任何检查会失败**。
 *
 * 本门禁只做一件事：读取全部清单，断言版本号完全一致。刻意**不**要求版本号
 * 等于最新 Release 标签：模块版本（源码内声明的 SemVer）与发布标签（`v0.10.6`
 * 等）是两套语义，混在一起会逼着每次发版都改 7 个文件，反而制造新的漂移。
 *
 * 与 `scripts/check-deno-version.ts` 同属「静态断言防漂移」的既有做法。
 */

/** 清单格式：JSON（`deno.json` / `package.json`）或 TOML（`Cargo.toml`）。 */
export type ManifestKind = "json" | "toml";

/** 单个受检模块清单。 */
export interface VersionManifest {
  /** 相对仓库根的路径。 */
  path: string;
  /** 清单格式。 */
  kind: ManifestKind;
}

/**
 * 参与版本一致性校验的模块清单（**单一事实源**）。
 *
 * 新增模块时只改这里；`checkVersionConsistency` 与测试都从本常量派生。
 */
export const VERSION_MANIFESTS: readonly VersionManifest[] = [
  { path: "noj-core/deno.json", kind: "json" },
  { path: "noj-ui/package.json", kind: "json" },
  { path: "noj-judge/Cargo.toml", kind: "toml" },
  { path: "noj-llm-gateway/deno.json", kind: "json" },
  { path: "noj-cli/deno.json", kind: "json" },
  { path: "noj-lmcc-extension/package.json", kind: "json" },
  { path: "noj-tests/deno.json", kind: "json" },
];

/** 从 JSON 清单文本提取顶层 `version`；缺失或非字符串返回 `null`。 */
export function parseJsonManifestVersion(content: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>).version;
  return typeof value === "string" ? value : null;
}

/**
 * 从 `Cargo.toml` 文本提取 `[package]` 的 `version`。
 *
 * 只认**行首**的 `version = "..."`：`[dependencies]` 里的版本是内联表
 * （`redis = { version = "0.27", ... }`）或别的键名，不会命中；若出现顶层
 * `version` 以外的同名行，取第一个（Cargo 的 `[package]` 段在最前）。
 */
export function parseTomlManifestVersion(content: string): string | null {
  for (const line of content.split("\n")) {
    const m = line.match(/^version\s*=\s*"([^"]+)"/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** 按清单格式提取版本号。 */
export function parseManifestVersion(
  kind: ManifestKind,
  content: string,
): string | null {
  return kind === "json"
    ? parseJsonManifestVersion(content)
    : parseTomlManifestVersion(content);
}

/** 版本号是否形如 `X.Y.Z`（允许 SemVer 预发布/构建后缀）。 */
export function isVersionLike(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

/** 单个清单的读取结果（纯数据，便于测试）。 */
export interface VersionEntry {
  /** 相对仓库根的清单路径。 */
  path: string;
  /** 解析出的版本；`null` 表示文件缺失或无法解析。 */
  version: string | null;
}

/**
 * 纯函数：判定一组清单版本是否一致。
 *
 * @param entries 各清单的解析结果
 * @returns 错误列表；空数组表示通过
 */
export function compareVersions(
  entries: readonly VersionEntry[],
): string[] {
  const errors: string[] = [];

  // 零输入守卫：清单为空时「版本一致」是假绿。
  if (entries.length === 0) {
    errors.push("未扫描到任何模块清单：版本一致性门禁可能已失效");
    return errors;
  }

  const resolved: VersionEntry[] = [];
  for (const entry of entries) {
    if (entry.version === null) {
      errors.push(
        entry.path + " 无法解析出 version（文件缺失、JSON 非法或缺少该字段）",
      );
      continue;
    }
    if (!isVersionLike(entry.version)) {
      errors.push(
        entry.path + " 的 version 不是合法的 X.Y.Z：" + entry.version,
      );
      continue;
    }
    resolved.push(entry);
  }

  if (resolved.length === 0) {
    return errors;
  }

  const distinct = [...new Set(resolved.map((e) => e.version as string))];
  if (distinct.length > 1) {
    // 以出现次数最多的版本为基准（并列时取先出现的），便于指出「谁漂移了」。
    const counts = new Map<string, number>();
    for (const e of resolved) {
      const v = e.version as string;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let expected = distinct[0];
    for (const v of distinct) {
      if ((counts.get(v) ?? 0) > (counts.get(expected) ?? 0)) expected = v;
    }
    const detail = resolved
      .map((e) => "    " + e.path + " = " + e.version)
      .join("\n");
    errors.push(
      "模块版本号不一致（基准 " + expected + "，来自多数清单）：\n" + detail +
        "\n请把上述清单的 version 统一为同一个值。",
    );
  }

  return errors;
}

/** 读取并校验全部模块清单，返回错误列表（空数组 = 通过）。 */
export async function checkVersionConsistency(root = "."): Promise<string[]> {
  const base = root.replace(/\/$/, "");
  const entries: VersionEntry[] = [];
  for (const manifest of VERSION_MANIFESTS) {
    let version: string | null = null;
    try {
      const content = await Deno.readTextFile(base + "/" + manifest.path);
      version = parseManifestVersion(manifest.kind, content);
    } catch {
      version = null;
    }
    entries.push({ path: manifest.path, version });
  }
  return compareVersions(entries);
}

if (import.meta.main) {
  const errors = await checkVersionConsistency();
  if (errors.length > 0) {
    console.error("模块版本一致性检查失败：");
    for (const e of errors) console.error("  - " + e);
    Deno.exit(1);
  }
  console.log(
    "模块版本一致性检查通过（" + VERSION_MANIFESTS.length +
      " 个模块清单版本一致）",
  );
}
