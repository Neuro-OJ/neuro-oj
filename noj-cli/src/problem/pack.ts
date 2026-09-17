/**
 * 纯 JS 题目包打包（#514 P1）。
 *
 * 早先 `noj-core/scripts/noj.ts` 直接调用系统 `zip` 命令：
 * Windows、精简容器、CI 均可能没有 `zip`（`problems-init.ts` 的 README 甚至
 * 教用户先 `mkdir -p data/packages` 来绕开首次失败）。
 *
 * 改用 `fflate` 在内存中打包，**零外部命令依赖**，排除规则与原实现对齐。
 */
import { zipSync } from "fflate";

/** 打包排除规则（与 `noj.ts:91-104` 及 quality.md 对齐）。 */
export const PACK_EXCLUDES = {
  /** 参考实现一律排除（不得进入题目包）。 */
  submissionPrefix: "submission",
  /** 字节码缓存目录。 */
  pycache: "__pycache__",
  /** git 元数据。 */
  gitDir: ".git/",
} as const;

/** 是否应把该相对路径排除出题目包。 */
export function shouldExclude(
  relativePath: string,
  templateName?: string,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;

  // submission*（参考实现）
  if (base.startsWith(PACK_EXCLUDES.submissionPrefix)) return true;
  // __pycache__（任意层级）
  if (normalized.split("/").includes(PACK_EXCLUDES.pycache)) return true;
  // .git
  if (
    normalized.startsWith(PACK_EXCLUDES.gitDir) ||
    normalized.includes("/" + PACK_EXCLUDES.gitDir)
  ) return true;
  // manifest 模板文件（脚手架产物，不应进包）
  if (base === "manifest.template.json" || base === "problem.template.json") {
    return true;
  }
  // 打包脚本本身（出题人本地工具，不属于题目内容）
  if (base.endsWith(".sh") && base.startsWith("build_")) return true;
  // 显式模板文件由调用方决定是否排除（模板要进包，供前端编辑器使用）
  if (templateName !== undefined && base === templateName) return false;
  // lint 报告等本地产物
  if (base === ".DS_Store") return true;
  return false;
}

/** 打包输入：相对路径 → 字节。 */
export interface PackInput {
  entries: Record<string, Uint8Array>;
  /** manifest.template 指定的模板文件名（保留在包内）。 */
  templateName?: string;
}

/** 打包结果。 */
export interface PackResult {
  data: Uint8Array;
  /** 实际写入包的条目名（排序后，便于断言）。 */
  included: string[];
  /** 被排除的条目名（排序后）。 */
  excluded: string[];
}

/**
 * 打包含有题目内容的 zip（内存中完成，不落盘）。
 *
 * 使用 `zipSync` 的 `level: 6`（与原 `zip -r` 的默认压缩级别接近，
 * 兼顾体积与速度）。
 */
export function packBundle(input: PackInput): PackResult {
  const included: string[] = [];
  const excluded: string[] = [];
  const payload: Record<string, Uint8Array> = {};

  for (const [name, data] of Object.entries(input.entries)) {
    if (shouldExclude(name, input.templateName)) {
      excluded.push(name);
      continue;
    }
    payload[name] = data;
    included.push(name);
  }

  const data = zipSync(payload, { level: 6 });
  return {
    data,
    included: included.sort(),
    excluded: excluded.sort(),
  };
}
