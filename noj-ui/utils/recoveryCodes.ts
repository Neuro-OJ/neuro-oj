/**
 * TFA 恢复码文件格式工具。
 *
 * 文件仅在浏览器本地生成/解析，不包含任何服务端交互逻辑。
 */

/** 恢复码文件最大体积，避免读取异常大的本地文件。 */
export const RECOVERY_CODE_FILE_MAX_BYTES = 64 * 1024;

/** 当前系统每组恢复码的最大数量。 */
export const RECOVERY_CODE_MAX_COUNT = 10;

/** 与 noj-core/src/lib/tfa.ts 保持一致：去除 0/O/1/I。 */
const RECOVERY_CODE_GROUP = '[A-HJ-NP-Z2-9]{4}';

/** 恢复码格式：XXXX-XXXX-XXXX。 */
export const RECOVERY_CODE_PATTERN = new RegExp(
  `^${RECOVERY_CODE_GROUP}(?:-${RECOVERY_CODE_GROUP}){2}$`,
);

/** 将用户文件中的恢复码统一为后端接受的规范形式。 */
export function normalizeRecoveryCode(value: string): string {
  return value.trim().toUpperCase();
}

/** 判断单个字符串是否为有效恢复码。 */
export function isRecoveryCode(value: string): boolean {
  return RECOVERY_CODE_PATTERN.test(normalizeRecoveryCode(value));
}

/** 检查本地文件大小。 */
export function assertRecoveryCodeFileSize(size: number): void {
  if (!Number.isFinite(size) || size < 0 || size > RECOVERY_CODE_FILE_MAX_BYTES) {
    throw new Error('恢复码文件过大，最大支持 64 KB');
  }
}

function validateCodes(codes: readonly string[]): string[] {
  const normalizedCodes = codes.map(normalizeRecoveryCode);
  if (normalizedCodes.length === 0) {
    throw new Error('恢复码文件中没有可用恢复码');
  }
  if (normalizedCodes.length > RECOVERY_CODE_MAX_COUNT) {
    throw new Error(`恢复码数量不能超过 ${RECOVERY_CODE_MAX_COUNT} 个`);
  }
  if (normalizedCodes.some((code) => !RECOVERY_CODE_PATTERN.test(code))) {
    throw new Error('恢复码格式无效，应为 XXXX-XXXX-XXXX');
  }
  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw new Error('恢复码文件中存在重复恢复码');
  }
  return normalizedCodes;
}

/**
 * 将恢复码格式化为可下载的 UTF-8 文本文件内容。
 * 以 # 开头的行是给用户看的说明，恢复码保持一行一个。
 */
export function formatRecoveryCodesFile(
  codes: readonly string[],
  generatedAt: Date = new Date(),
): string {
  const normalizedCodes = validateCodes(codes);
  return [
    '# Neuro OJ 两步验证恢复码',
    '# 每个恢复码只能使用一次；重新生成后，旧恢复码全部失效。',
    `# 生成时间（UTC）：${generatedAt.toISOString()}`,
    '',
    ...normalizedCodes,
    '',
  ].join('\n');
}

/**
 * 解析用户选择的恢复码文本文件。
 * 空行和 # 注释行会被忽略，其他非空行必须是一个合法恢复码。
 */
export function parseRecoveryCodesFile(text: string): string[] {
  const codes: string[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;

    const code = normalizeRecoveryCode(line);
    if (!RECOVERY_CODE_PATTERN.test(code)) {
      throw new Error(`第 ${index + 1} 行不是有效恢复码`);
    }
    if (!codes.includes(code)) codes.push(code);
  }

  return validateCodes(codes);
}
