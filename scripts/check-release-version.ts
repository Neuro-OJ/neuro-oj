/**
 * 发布阶段版本校验（0.11 RC 发布身份约束）。
 *
 * 背景：`check-version-consistency.ts` 只断言 7 个模块清单**彼此一致**，刻意不绑定
 * Release 标签（模块版本与发布标签是两套语义）。它能拦住"清单之间漂移"，但拦不住
 * "标签是 v0.11.0，源码清单却还写着 0.10.5"——而那正是 0.10.6 之后 412 个提交
 * 没有发生任何版本跃迁时的状态：门禁全绿、产物身份却与发布说明错位。
 *
 * 本脚本补上发布阶段的那一半：**标签的基础版本必须等于清单版本的基础版本**。
 * 仍然允许预发布后缀，因此：
 * - 标签 `v0.11.0-rc.1` + 清单 `0.11.0` → 通过（RC 阶段清单不提前写 -rc 后缀）
 * - 标签 `v0.11.0` + 清单 `0.11.0` → 通过
 * - 标签 `v0.11.0-rc.1` + 清单 `0.11.0-rc.1` → 通过（清单自带后缀同样合法）
 * - 标签 `v0.11.1-rc.1` + 清单 `0.11.0` → 失败（发布说明与产物身份错位）
 * - 标签 `0.11` → 失败（不是合法 Release 标签）
 *
 * 用法：
 *   deno run -A scripts/check-release-version.ts v0.11.0-rc.1
 *   GITHUB_REF_NAME=v0.11.0-rc.1 deno run -A scripts/check-release-version.ts
 *
 * 未提供标签时（本地 `check-all` 的常规场景）跳过并返回 0：它不是静态门禁，而是
 * 发布流水线的前置断言。
 */

import {
  checkVersionConsistency,
  parseManifestVersion,
  VERSION_MANIFESTS,
} from "./check-version-consistency.ts";

/** 去掉列表项的 `v` 前缀，拆成基础版本与预发布后缀。 */
export interface NormalizedVersion {
  /** 基础版本（`X.Y.Z`） */
  base: string;
  /** 预发布 / 构建后缀（含分隔符，如 `-rc.1`）；无后缀时为空串 */
  suffix: string;
}

/** 合法 Release 标签形态：`v?X.Y.Z` 后接可选预发布/构建后缀。 */
const RELEASE_TAG_RE = /^v?(\d+\.\d+\.\d+)([-+][0-9A-Za-z.-]+)?$/;

/**
 * 把版本串拆成基础版本与后缀。
 *
 * @param value 版本串（可带 `v` 前缀）
 * @returns 拆分结果；非法形态返回 `null`
 */
export function normalizeVersion(value: string): NormalizedVersion | null {
  const m = RELEASE_TAG_RE.exec(value.trim());
  if (!m) return null;
  return { base: m[1]!, suffix: m[2] ?? "" };
}

/**
 * 纯函数：判定发布标签与清单基础版本是否一致。
 *
 * @param tag Release 标签或 `GITHUB_REF_NAME`
 * @param manifestVersion 清单中的版本（取第一个解析成功的清单）
 * @returns 错误列表；空数组表示通过
 */
export function compareReleaseVersion(
  tag: string,
  manifestVersion: string,
): string[] {
  const tagVersion = normalizeVersion(tag);
  if (!tagVersion) {
    return [
      `Release 标签不是合法形态（期望 vX.Y.Z 或 vX.Y.Z-rc.N）：${tag}`,
    ];
  }
  const manifest = normalizeVersion(manifestVersion);
  if (!manifest) {
    return [
      `清单版本不是合法形态（期望 X.Y.Z 或 X.Y.Z-rc.N）：${manifestVersion}`,
    ];
  }
  if (tagVersion.base !== manifest.base) {
    return [
      `Release 标签 ${tag} 的基础版本是 ${tagVersion.base}，` +
      `但模块清单写的是 ${manifestVersion}（基础版本 ${manifest.base}）。` +
      `发布前请把 7 个清单的 version 同步为 ${tagVersion.base}。`,
    ];
  }
  return [];
}

/** 读取第一个可解析的清单版本（清单间一致性由另一个门禁负责）。 */
export async function readManifestVersion(
  root = ".",
): Promise<{ path: string; version: string } | null> {
  const base = root.replace(/\/$/, "");
  for (const manifest of VERSION_MANIFESTS) {
    try {
      const content = await Deno.readTextFile(base + "/" + manifest.path);
      const version = parseManifestVersion(manifest.kind, content);
      if (version) return { path: manifest.path, version };
    } catch {
      // 清单缺失：继续找下一个，最终返回 null 由调用方报错。
    }
  }
  return null;
}

if (import.meta.main) {
  const tag = (Deno.args[0] ?? Deno.env.get("GITHUB_REF_NAME") ?? "").trim();
  if (!tag) {
    console.log(
      "发布阶段版本校验跳过：未提供 Release 标签" +
        "（用法：deno run -A scripts/check-release-version.ts v0.11.0-rc.1）",
    );
    Deno.exit(0);
  }

  const errors = await checkVersionConsistency();
  if (errors.length > 0) {
    console.error("发布阶段版本校验失败（模块清单彼此不一致）：");
    for (const e of errors) console.error("  - " + e);
    Deno.exit(1);
  }

  const manifest = await readManifestVersion();
  if (!manifest) {
    console.error("发布阶段版本校验失败：没有任何模块清单可解析出版本号");
    Deno.exit(1);
  }

  const tagErrors = compareReleaseVersion(tag, manifest.version);
  if (tagErrors.length > 0) {
    console.error("发布阶段版本校验失败：");
    for (const e of tagErrors) console.error("  - " + e);
    Deno.exit(1);
  }

  const commit = Deno.env.get("GITHUB_SHA") ?? "(未提供 GITHUB_SHA)";
  console.log(
    `发布阶段版本校验通过：标签 ${tag} ↔ 清单 ${manifest.path} = ` +
      `${manifest.version}；commit ${commit}`,
  );
}
