/**
 * 统一题目包（Problem Bundle）zip 解析与剥离。
 *
 * 职责：
 * - `parseBundleZip`：读取 zip 条目并执行 ZIP 安全校验（路径穿越、条目数、
 *   单文件大小、总解压大小——对齐 judge 端 `sandbox/container.rs` 常量），
 *   提取 `problem.json`（解析为 JSON）与 `statement.md` 内容
 * - `stripMetadataEntries`：剔除 `problem.json`/`statement.md` 两个固定名
 *   元数据条目后重建"纯净评测包"（`evaluate.py` 保持根级），供 storage 存储
 *
 * 使用 `fflate`（npm）纯内存操作，不落盘解压。
 * 注意：fflate 0.8.x 的 `unzipSync` 返回 `Record<string, Uint8Array>`（路径 → 数据映射），
 * 支持 `filter` 选项跳过条目。
 */

import { unzipSync, zipSync } from "fflate";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { BUNDLE_METADATA_ENTRIES } from "./../types/problem-bundle.ts";

/** 对齐 judge 端 `MAX_ZIP_ENTRIES`。 */
export const MAX_ZIP_ENTRIES = 1000;
/** 对齐 judge 端 `MAX_FILE_SIZE`（64 MiB）。 */
export const MAX_FILE_SIZE = 64 * 1024 * 1024;
/** 对齐 judge 端 `MAX_TOTAL_SIZE`（512 MiB）。 */
export const MAX_TOTAL_SIZE = 512 * 1024 * 1024;

/**
 * 解析后的统一题目包。
 */
export interface ParsedProblemBundle {
  /** 校验并规范化后的 manifest（`problem.json`）。 */
  manifest: Record<string, unknown>;
  /** `statement.md` 内容（不存在时为 null）。 */
  statement: string | null;
  /** `questions.json` 内容（客观题包；不存在为 null） */
  questions: unknown | null;
  /** zip 全部条目（路径 → 数据，含元数据文件，供剥离与构建使用）。 */
  entries: Record<string, Uint8Array>;
}

/**
 * 校验条目路径安全：拒绝路径穿越（`..` 段）与绝对路径（`/` 开头）。
 *
 * 与 judge 端 `extract_zip_entries` 的校验语义一致。
 */
function assertSafeEntryPath(name: string): void {
  if (name.startsWith("/")) {
    throw new BadRequestError(`zip 条目含绝对路径：${name}`);
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new BadRequestError(`zip 条目含路径穿越：${name}`);
    }
  }
}

/**
 * 解析 zip 字节并执行安全校验，提取 manifest 与 statement.md。
 *
 * 校验失败抛 `BadRequestError`（HTTP 400）。
 *
 * @throws {BadRequestError} 根级缺 problem.json / 根级缺 evaluate.py /
 *   ZIP 安全校验失败 / manifest 非法 JSON
 */
export function parseBundleZip(data: Uint8Array): ParsedProblemBundle {
  let files: Record<string, Uint8Array>;
  try {
    // 解压前预检：fflate 的 filter 回调在中央目录阶段即可拿到条目元数据
    // （name / originalSize），基于此早期拒绝超限条目，避免 zip 炸弹先全量
    // 解压到内存再校验（压缩率极高的包可能在解压途中 OOM）。
    let count = 0;
    let totalSize = 0;
    files = unzipSync(data, {
      filter: (file) => {
        count++;
        if (count > MAX_ZIP_ENTRIES) {
          throw new BadRequestError(`zip 条目数超过上限 ${MAX_ZIP_ENTRIES}`);
        }
        if (file.originalSize > MAX_FILE_SIZE) {
          throw new BadRequestError(
            `zip 条目超过单文件上限 ${
              MAX_FILE_SIZE / 1024 / 1024
            } MiB：${file.name}`,
          );
        }
        totalSize += file.originalSize;
        if (totalSize > MAX_TOTAL_SIZE) {
          throw new BadRequestError(
            `zip 总解压大小超过上限 ${MAX_TOTAL_SIZE / 1024 / 1024} MiB`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    // filter 预检抛出的 BadRequestError 原样上抛；其余视为 zip 格式错误
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError("zip 解析失败：文件不是有效的 zip 格式");
  }

  const entries = Object.entries(files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new BadRequestError(
      `zip 条目数超过上限 ${MAX_ZIP_ENTRIES}`,
    );
  }

  let totalSize = 0;
  const rootNames = new Set<string>();
  for (const [name, content] of entries) {
    assertSafeEntryPath(name);
    if (content.length > MAX_FILE_SIZE) {
      throw new BadRequestError(`zip 条目超过单文件上限 64 MiB：${name}`);
    }
    totalSize += content.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new BadRequestError("zip 总解压大小超过上限 512 MiB");
    }
    // 根级条目名（不含目录分隔符）
    if (!name.includes("/")) {
      rootNames.add(name);
    }
  }

  if (!rootNames.has("problem.json")) {
    throw new BadRequestError(
      "zip 根级缺少 problem.json（必须使用统一题目包格式）",
    );
  }
  const manifestFile = files["problem.json"];
  const statementFile = files["statement.md"];

  let manifest: Record<string, unknown>;
  try {
    const text = new TextDecoder().decode(manifestFile);
    const parsed = JSON.parse(text);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("not-object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestError("problem.json 不是合法的 JSON 对象");
  }

  const isObjective = manifest.is_objective === true;
  if (isObjective) {
    if (!rootNames.has("questions.json")) {
      throw new BadRequestError(
        "客观题套卷包必须包含 questions.json（小题数组）",
      );
    }
  } else if (!rootNames.has("evaluate.py")) {
    throw new BadRequestError(
      "zip 根级缺少 evaluate.py（评测脚本必须位于包根级）",
    );
  }

  const questionsFile = files["questions.json"];
  let questions: unknown = null;
  if (questionsFile) {
    try {
      questions = JSON.parse(new TextDecoder().decode(questionsFile));
    } catch {
      throw new BadRequestError("questions.json 不是合法的 JSON");
    }
  }

  return {
    manifest,
    statement: statementFile ? new TextDecoder().decode(statementFile) : null,
    questions,
    entries: files,
  };
}

/**
 * 剥离 `problem.json`/`statement.md` 元数据条目，重建纯净评测包 zip。
 *
 * 其余条目（evaluate.py、testcase、assets 等）原样保留；
 * `evaluate.py` 保持根级。返回重建后的 zip 字节。
 */
export function stripMetadataEntries(data: Uint8Array): Uint8Array {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) =>
        !(BUNDLE_METADATA_ENTRIES as readonly string[]).includes(file.name),
    });
  } catch {
    throw new BadRequestError("zip 解析失败：文件不是有效的 zip 格式");
  }

  return zipSync(files, { level: 6 });
}
