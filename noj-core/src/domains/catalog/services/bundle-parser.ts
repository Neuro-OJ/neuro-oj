import {
  normalizeHydroOiConfig,
  normalizeNojOiConfig,
  parseConfigYaml,
} from "./oi-config-import.ts";
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
import {
  BUNDLE_METADATA_ENTRIES,
  DEFAULT_TEMPLATE_FILE,
  isValidTemplateFileName,
  MAX_TEMPLATE_BYTES,
} from "./../types/problem-bundle.ts";
import { validateOiRuntimeConfig } from "../types/runtime-config.ts";

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

/** 发布前评测包的静态检查结果。 */
export interface EvaluationPackageInspection {
  hasEvaluator: boolean;
  hasVisibleCases: boolean;
  hasHiddenCases: boolean;
  referenceSolution: string | null;
}

/**
 * 校验条目路径安全：拒绝路径穿越（`..` 段）与绝对路径（`/` 开头）。
 *
 * 与 judge 端 `extract_zip_entries` 的校验语义一致。
 */
function assertSafeEntryPath(name: string): void {
  if (
    name.startsWith("/") || name.includes("\\") || name.includes("\0") ||
    /^[A-Za-z]:/.test(name)
  ) {
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

  let manifest: Record<string, unknown>;
  let statementFile = files["statement.md"];
  if (files["problem.json"]) {
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(files["problem.json"]),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error();
      }
      manifest = parsed;
    } catch {
      throw new BadRequestError("problem.json 不是合法的 JSON 对象");
    }
    if (manifest.judge_type === "oi") {
      const configFile = files["config.yaml"] ?? files["config.yml"];
      manifest.runtime_config = normalizeNojOiConfig(
        configFile ? parseConfigYaml(configFile) : manifest.runtime_config,
      );
    }
  } else if (files["problem.yaml"]) {
    const metadata = parseConfigYaml(files["problem.yaml"]);
    const configFile = files["testdata/config.yaml"] ??
      files["testdata/config.yml"];
    manifest = {
      format_version: 1,
      title: metadata.title,
      type: "U",
      judge_type: "oi",
      runtime_config: normalizeHydroOiConfig(
        configFile ? parseConfigYaml(configFile) : {},
        files,
      ),
    };
    statementFile = files["problem.md"] ?? files["problem_zh.md"] ??
      files["statement.md"];
    if (!statementFile) {
      throw new BadRequestError("Hydro 题包缺少题面 problem.md");
    }
  } else {
    throw new BadRequestError(
      "zip 根级缺少 problem.json 或 Hydro problem.yaml",
    );
  }

  const isObjective = manifest.is_objective === true;
  if (isObjective) {
    if (!rootNames.has("questions.json")) {
      throw new BadRequestError(
        "客观题套卷包必须包含 questions.json（小题数组）",
      );
    }
  } else if (manifest.judge_type === "oi") {
    validateOiRuntimeConfig(manifest.runtime_config);
    const config = manifest.runtime_config;
    const referenced = config.subtasks.flatMap((subtask) =>
      subtask.cases.flatMap((testCase) => [testCase.input, testCase.output])
    );
    if (config.checker.type === "testlib") {
      referenced.push(config.checker.path!);
    }
    referenced.push(
      ...(config.compile_extra_files ?? []),
      ...(config.user_extra_files ?? []),
    );
    for (const path of referenced) {
      if (!Object.hasOwn(files, path)) {
        throw new BadRequestError(`OI 题包缺少引用文件：${path}`);
      }
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
 * 检查已剥离元数据的评测包是否具备发布前静态验收所需的条目。
 *
 * 这里不执行 evaluator，也不把“存在隐藏数据”当成“隐藏数据绝不会泄漏”；
 * 真正的运行、超时、资源清理和隐藏标记验证必须在隔离 Judge 中完成。
 */
export function inspectEvaluationPackage(
  data: Uint8Array,
): EvaluationPackageInspection {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new BadRequestError("评测包不是有效的 zip 文件");
  }

  const names = Object.keys(files);
  const rootNames = new Set(names.filter((name) => !name.includes("/")));
  const referenceCandidates = [
    "reference_solution.py",
    "standard_solution.py",
    "solution.py",
  ];
  return {
    hasEvaluator: rootNames.has("evaluate.py"),
    hasVisibleCases: rootNames.has("visible.jsonl"),
    hasHiddenCases: rootNames.has("hidden.jsonl") ||
      names.some((name) => name.startsWith("hidden/")),
    referenceSolution:
      referenceCandidates.find((name) => rootNames.has(name)) ??
        null,
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

/** 读取题包内模板文件的结果。 */
export type BundleTemplateReadResult =
  | { status: "ok"; content: string }
  /** 包内不存在该条目（题目可以不提供模板，不必然算错误） */
  | { status: "missing" }
  /** 条目存在但超过 {@link MAX_TEMPLATE_BYTES}，拒绝落库 */
  | { status: "too_large"; size: number };

/**
 * 从已解析的题包条目中读取编辑器初始代码模板（starter code）。
 *
 * 文件名由 manifest `template` 声明（缺省 `template.py`），仅接受**纯文件名**
 * （`isValidTemplateFileName`），非法值回退默认名——与打包侧、编辑器读取侧
 * 共用同一规则，避免通过 `../` 读到包外条目。
 *
 * 兼容 `./name` 前缀形式：部分 zip 工具给根级条目加 `./`（本仓库的出题脚本
 * `build_bundle.sh` 即如此）。
 *
 * @param entries `parseBundleZip` 返回的条目表（路径 → 字节）
 * @param templateFile manifest 声明的模板文件名（可为空 → 默认 `template.py`）
 */
export function readBundleTemplate(
  entries: Record<string, Uint8Array>,
  templateFile?: string | null,
): BundleTemplateReadResult {
  const name = typeof templateFile === "string" &&
      isValidTemplateFileName(templateFile)
    ? templateFile
    : DEFAULT_TEMPLATE_FILE;

  const raw = entries[name] ?? entries[`./${name}`];
  if (!raw) return { status: "missing" };
  if (raw.byteLength > MAX_TEMPLATE_BYTES) {
    return { status: "too_large", size: raw.byteLength };
  }
  return { status: "ok", content: new TextDecoder().decode(raw) };
}
