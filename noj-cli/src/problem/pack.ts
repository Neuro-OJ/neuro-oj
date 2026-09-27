/**
 * 纯 JS 题目包打包（#514 P1）。
 *
 * 早先 `noj-core/scripts/noj.ts` 直接调用系统 `zip` 命令：
 * Windows、精简容器、CI 均可能没有 `zip`（`problems-init.ts` 的 README 甚至
 * 教用户先 `mkdir -p data/packages` 来绕开首次失败）。
 *
 * 改用 `fflate` 在内存中打包，**零外部命令依赖**，排除规则与原实现对齐：
 * `submission*`（参考实现）、`__pycache__`、`.git`、本地脚手架/报告文件。
 *
 * **模板文件必须进包**（2026-09 修正）：编辑器初始代码（`manifest.template`，
 * 缺省 `template.py`）由平台在导入题目包时读取并落库到
 * `problems.template_content`，运行期据此返回
 * （`GET /api/v1/problems/:id/template`）。此前规则是"模板不进入包"，平台只能去
 * 服务器本地 `data/problems-src` 找模板——容器化生产没有该目录，于是所有线上
 * 题目的编辑器都没有初始代码。参考实现仍必须排除（见 `submission*`）。
 */
import { zipSync } from "fflate";

/** 打包排除规则（与 `noj.ts` 及 quality.md 对齐）。 */
export const PACK_EXCLUDES = {
  /** 参考实现一律排除（不得进入题目包）。 */
  submissionPrefix: "submission",
  /** 字节码缓存目录。 */
  pycache: "__pycache__",
  /** git 元数据。 */
  gitDir: ".git/",
} as const;

/** 是否应把该相对路径排除出题目包。 */
export function shouldExclude(relativePath: string): boolean {
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
  // 注意：题目模板文件（template.py / manifest.template 指定名）**不排除**——
  // 平台导入题目包时从这里取编辑器初始代码，详见文件头说明。
  // lint 报告等本地产物
  if (base === ".DS_Store") return true;
  return false;
}

/** 打包输入：相对路径 → 字节。 */
export interface PackInput {
  entries: Record<string, Uint8Array>;
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
    if (shouldExclude(name)) {
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
