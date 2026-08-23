/** utils/recoveryCodes.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  assertRecoveryCodeFileSize,
  formatRecoveryCodesFile,
  isRecoveryCode,
  parseRecoveryCodesFile,
  RECOVERY_CODE_FILE_MAX_BYTES,
} from '../utils/recoveryCodes.ts';

const CODE_A = 'ABCD-EFGH-JKLM';
const CODE_B = 'NPQR-STUV-WXYZ';

Deno.test('recoveryCodes: 校验后端约定的恢复码格式', () => {
  assertEquals(isRecoveryCode(CODE_A), true);
  assertEquals(isRecoveryCode('abcd-efgh-jklm'), true);
  assertEquals(isRecoveryCode('ABCD-EFGH-JKLM-NOPQ'), false);
  assertEquals(isRecoveryCode('ABCD-EFGH-JKLO'), false);
  assertEquals(isRecoveryCode('ABCD-EFGH-JK10'), false);
});

Deno.test('recoveryCodes: 生成带说明且一行一个恢复码的文件内容', () => {
  const output = formatRecoveryCodesFile([CODE_A, CODE_B], new Date('2026-08-23T00:00:00.000Z'));
  assertEquals(
    output,
    [
      '# Neuro OJ 两步验证恢复码',
      '# 每个恢复码只能使用一次；重新生成后，旧恢复码全部失效。',
      '# 生成时间（UTC）：2026-08-23T00:00:00.000Z',
      '',
      CODE_A,
      CODE_B,
      '',
    ].join('\n'),
  );
});

Deno.test('recoveryCodes: 解析注释、空白、大小写并去重', () => {
  const text = `\uFEFF# 说明\n  ${CODE_A.toLowerCase()}  \n\n# 第二行说明\n${CODE_B}\n`;
  assertEquals(parseRecoveryCodesFile(text), [CODE_A, CODE_B]);
});

Deno.test('recoveryCodes: 非法行和空文件会被拒绝，重复码会去重', () => {
  assertThrows(() => parseRecoveryCodesFile('# 只有说明'));
  assertThrows(() => parseRecoveryCodesFile(`${CODE_A}\n不是恢复码`));
  assertEquals(parseRecoveryCodesFile(`${CODE_A}\n${CODE_A}`), [CODE_A]);
});

Deno.test('recoveryCodes: 恢复码数量最多为 10 个', () => {
  const codes = [
    'ABCD-EFGH-JKLM',
    'ABCD-EFGH-JKLN',
    'ABCD-EFGH-JKLP',
    'ABCD-EFGH-JKMQ',
    'ABCD-EFGH-JKMR',
    'ABCD-EFGH-JKMS',
    'ABCD-EFGH-JKMT',
    'ABCD-EFGH-JKMU',
    'ABCD-EFGH-JKMV',
    'ABCD-EFGH-JKMW',
    'ABCD-EFGH-JKMX',
  ];
  assertThrows(() => parseRecoveryCodesFile(codes.join('\n')));
});

Deno.test('recoveryCodes: 文件大小超过限制时拒绝读取', () => {
  assertRecoveryCodeFileSize(RECOVERY_CODE_FILE_MAX_BYTES);
  assertThrows(() => assertRecoveryCodeFileSize(RECOVERY_CODE_FILE_MAX_BYTES + 1));
});
