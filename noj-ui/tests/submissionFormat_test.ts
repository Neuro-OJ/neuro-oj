/**
 * utils/submissionFormat.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  formatAcceptanceRate,
  formatDateTime,
  formatMemory,
  formatScore,
  formatTime,
  getLanguageLabel,
  getResultDef,
  getStatusColor,
  getStatusLabel,
} from '../utils/submissionFormat.ts';

Deno.test('formatScore: 正常值、零值与空值', () => {
  assertEquals(formatScore(100), '1.0');
  assertEquals(formatScore(0), '0.0');
  assertEquals(formatScore(null), '--');
  assertEquals(formatScore(undefined), '--');
});

Deno.test('formatTime: 毫秒与秒', () => {
  assertEquals(formatTime(500), '500ms');
  assertEquals(formatTime(1500), '1.50s');
  assertEquals(formatTime(null), '--');
});

Deno.test('formatMemory: KB/MB/GB', () => {
  assertEquals(formatMemory(512), '512KB');
  assertEquals(formatMemory(1536), '1.5MB');
  assertEquals(formatMemory(2097152), '2.00GB');
  assertEquals(formatMemory(null), '--');
});

Deno.test('getStatusColor: result 优先，state 回退，未知兜底', () => {
  assertEquals(getStatusColor('finished', 'Accepted'), '#10b981');
  assertEquals(getStatusColor('pending', null), '#9ca3af');
  assertEquals(getStatusColor('unknown', null), '#6b7280');
});

Deno.test('getStatusLabel: result 优先，state 回退，未知原样返回', () => {
  assertEquals(getStatusLabel('finished', 'Accepted'), '答案正确');
  assertEquals(getStatusLabel('pending', null), '等待评测');
  assertEquals(getStatusLabel('unknown', null), 'unknown');
});

Deno.test('getLanguageLabel: 已知语言映射，未知原样返回', () => {
  assertEquals(getLanguageLabel('cpp'), 'C++');
  assertEquals(getLanguageLabel('java'), 'Java');
  assertEquals(getLanguageLabel('pascal'), 'pascal');
});

Deno.test('formatAcceptanceRate: 0-1 转百分号，空值占位', () => {
  assertEquals(formatAcceptanceRate(0.756), '75.6%');
  assertEquals(formatAcceptanceRate(1), '100.0%');
  assertEquals(formatAcceptanceRate(null), '--');
});

Deno.test('formatDateTime: 空值占位，合法时间非占位', () => {
  assertEquals(formatDateTime(null), '--');
  assertEquals(formatDateTime(undefined), '--');
  const out = formatDateTime('2026-08-17T00:00:00Z');
  assertEquals(out.includes('2026'), true);
});

Deno.test('getResultDef: 已知/未知状态返回定义', () => {
  assertEquals(getResultDef('Accepted').label, '答案正确');
  assertEquals(getResultDef('Accepted').class, 'accepted');
  assertEquals(getResultDef('Nope').label, 'Nope');
  assertEquals(getResultDef(undefined).label, '未知');
});
