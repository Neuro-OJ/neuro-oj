/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  bestStorageUnit,
  bytesToUnitValue,
  canLosslesslyConvert,
  GIB,
  MIB,
  unitValueToBytes,
  validateStorageInput,
} from '../utils/storage-limit.ts';

Deno.test('存储单位：任意字节不被默认格式化成两位小数而丢失精度', () => {
  for (const bytes of [1, MIB + 1, GIB + 1, Number.MAX_SAFE_INTEGER]) {
    assertEquals(bestStorageUnit(bytes), 'bytes');
    const unit = bestStorageUnit(bytes);
    assertEquals(unitValueToBytes(bytesToUnitValue(bytes, unit), unit), bytes);
    assertEquals(validateStorageInput(bytesToUnitValue(bytes, unit), unit), { valid: true, bytes });
  }
  assertEquals(bestStorageUnit(5 * GIB), 'gib');
  assertEquals(bestStorageUnit(3 * MIB), 'mib');
  assertEquals(canLosslesslyConvert(GIB + 1, 'gib'), false);
  assertEquals(canLosslesslyConvert(GIB, 'mib'), true);
});

Deno.test('存储单位：零、空值、非法值和安全整数上界保留不同语义', () => {
  assertEquals(validateStorageInput('0', 'bytes'), { valid: true, bytes: 0 });
  assertEquals(validateStorageInput('5', 'gib'), { valid: true, bytes: 5 * GIB });
  assertEquals(validateStorageInput('512', 'mib'), { valid: true, bytes: 512 * MIB });
  for (const invalid of ['', ' ', null, undefined, '-1', 'not-a-number', 'Infinity', '0.5']) {
    assertEquals(validateStorageInput(invalid, 'bytes').valid, false, String(invalid));
  }
  assertEquals(validateStorageInput(Number.MAX_SAFE_INTEGER, 'bytes').valid, true);
  assertEquals(validateStorageInput(Number.MAX_SAFE_INTEGER + 1, 'bytes').valid, false);
  assertEquals(validateStorageInput(Math.ceil(Number.MAX_SAFE_INTEGER / GIB), 'gib').valid, false);
});
