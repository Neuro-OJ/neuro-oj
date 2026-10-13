/**
 * prediction 提交文件格式校验（纯函数）。
 *
 * 目标：在把用户文件落存储 / 交给评测之前，尽早拦下「代码型」与「格式不符」
 * 的提交物。
 *
 * - 扩展名黑名单：pickle 类（`.pkl`/`.pickle`/`.pt`/`.pth`/`.bin`/`.joblib`/
 *   `.ckpt`）——反序列化即任意代码执行，与「数据非代码」的前提冲突；
 * - 扩展名白名单：`.csv`/`.tsv`/`.jsonl`/`.json`/`.txt`（结构化文本）+
 *   `.npy`/`.npz`（NumPy）+ `.parquet`（列式二进制）；
 * - 魔数校验：pickle 协议头（`\x80\x04`/`\x80\x05`）不论扩展名一律拒绝；
 *   二进制格式必须匹配各自魔数；结构化文本前若干字节不得含 NUL（含 NUL 基本
 *   可判定为伪装成文本的二进制）。
 *
 * 本函数不依赖 DB / 存储 / 网络，也不做副作用，便于纯单元测试。
 *
 * @module
 */

import { BadRequestError } from "./../../../../shared/base/errors.ts";

/** pickle 类扩展名黑名单（反序列化风险）。 */
const REJECTED_EXT: readonly string[] = [
  ".pkl",
  ".pickle",
  ".pt",
  ".pth",
  ".bin",
  ".joblib",
  ".ckpt",
];

/** 结构化文本格式白名单。 */
const TEXT_EXT: readonly string[] = [
  ".csv",
  ".tsv",
  ".jsonl",
  ".json",
  ".txt",
];

/** NumPy 二进制格式白名单。 */
const NUMPY_EXT: readonly string[] = [".npy", ".npz"];

/** Parquet 列式二进制格式白名单。 */
const PARQUET_EXT: readonly string[] = [".parquet"];

/** 全部允许的扩展名。 */
const ALLOWED_EXT: readonly string[] = [
  ...TEXT_EXT,
  ...NUMPY_EXT,
  ...PARQUET_EXT,
];

/** 统一的拒绝错误码，前端可据此做差异化提示。 */
const REJECTED_CODE = "PREDICTION_FORMAT_REJECTED";

/**
 * 校验文件名**形态**（2026-09-22 评审）。
 *
 * 为什么需要：选手上传的原始文件名会被透传到 judge 并拼成
 * `prediction/<file_name>` 注入容器。judge 侧的 `sanitize_rel_path` 会拒绝
 * 含 `..`/空段/前导 `/` 的路径，但**那是评测期**——届时选手拿到的是通用
 * 「系统内部错误」，而不是提交期的 400。例如 `a/../../x.csv`、`foo//bar.csv`
 * 会通过入库与入队，直到注入阶段才失败。
 *
 * 这里在提交期就拒绝：路径分隔符、控制字符、`.`/`..`、首尾空白。
 * 允许的文件名形态 = 单层普通文件名（可含 `.`、`-`、`_`、空格、Unicode）。
 *
 * @param fileName 原始文件名
 * @throws {BadRequestError} 文件名形态非法（错误码同上）
 */
export function validatePredictionFileName(fileName: string): void {
  const reject = (reason: string): never => {
    throw new BadRequestError(`预测文件名不合法：${reason}`, REJECTED_CODE);
  };
  if (fileName === "") reject("文件名为空");
  // 控制字符（含 NUL、换行）与路径分隔符：Windows 的反斜杠一并拒绝，
  // 避免跨平台注入语义差异。
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(fileName)) reject("含控制字符");
  if (fileName.includes("/") || fileName.includes("\\")) {
    reject("不得包含路径分隔符");
  }
  if (fileName === "." || fileName === "..") reject("不得为 . 或 ..");
  if (fileName.trim() !== fileName) reject("首尾不得有空白");
}

/** 从文件名提取小写扩展名；无扩展名时返回空串。 */
export function predictionFileExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf(".");
  return idx >= 0 ? lower.slice(idx) : "";
}

/** 判断字节序列是否为 pickle 协议头（`\x80\x04` / `\x80\x05`）。 */
function hasPickleHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x80 &&
    (bytes[1] === 0x04 || bytes[1] === 0x05);
}

/** 判断字节序列是否以给定字节序列开头。 */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/** ZIP 本地文件头魔数：`PK\x03\x04`。 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/** NumPy 文件魔数：`\x93NUMPY`。 */
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const;

/** Parquet 文件魔数：`PAR1`。 */
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31] as const;

/**
 * 校验 prediction 提交文件。
 *
 * @param fileName 原始文件名（用于判定扩展名，大小写不敏感）
 * @param firstBytes 文件头部字节（由 `peekFirstChunk` 取得）
 * @throws {BadRequestError} 错误码 `PREDICTION_FORMAT_REJECTED`
 */
export function validatePredictionFile(
  fileName: string,
  firstBytes: Uint8Array,
): void {
  // 先校验**文件名形态**：它会在 judge 侧参与路径拼接，必须在提交期拒绝。
  validatePredictionFileName(fileName);

  const ext = predictionFileExtension(fileName);

  // 先判黑名单：即使内容看似正常，pickle 类扩展名也直接拒绝。
  if (REJECTED_EXT.includes(ext)) {
    throw new BadRequestError(
      "禁止 pickle 类格式（存在反序列化风险）",
      REJECTED_CODE,
    );
  }
  if (!ALLOWED_EXT.includes(ext)) {
    throw new BadRequestError(
      `不支持的预测文件格式：${ext || "(无扩展名)"}`,
      REJECTED_CODE,
    );
  }

  // 魔数优先于扩展名：pickle 协议头出现在任何扩展名下都拒绝（防改名绕过）。
  if (hasPickleHeader(firstBytes)) {
    throw new BadRequestError("检测到 pickle 协议头，已拒绝", REJECTED_CODE);
  }

  if (ext === ".npz" && !startsWith(firstBytes, ZIP_MAGIC)) {
    throw new BadRequestError("npz 文件头不合法", REJECTED_CODE);
  }
  if (ext === ".npy" && !startsWith(firstBytes, NPY_MAGIC)) {
    throw new BadRequestError("npy 文件头不合法", REJECTED_CODE);
  }
  if (ext === ".parquet" && !startsWith(firstBytes, PARQUET_MAGIC)) {
    throw new BadRequestError("parquet 文件头不合法", REJECTED_CODE);
  }

  // 文本格式：首块含 NUL 字节基本可判定为二进制伪装。
  if (TEXT_EXT.includes(ext) && firstBytes.includes(0x00)) {
    throw new BadRequestError("预测文件含 NUL 字节，疑似二进制", REJECTED_CODE);
  }
}
