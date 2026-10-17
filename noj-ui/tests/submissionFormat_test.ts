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
  submissionVersionLabel,
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
  assertEquals(getStatusColor('finished', 'finished'), '#10b981');
  assertEquals(getStatusColor('finished', 'error'), '#ef4444');
  assertEquals(getStatusColor('pending', null), '#9ca3af');
  assertEquals(getStatusColor('unknown', null), '#6b7280');
});

Deno.test('getStatusLabel: result 优先，state 回退，未知原样返回', () => {
  assertEquals(getStatusLabel('finished', 'finished'), '已评测');
  assertEquals(getStatusLabel('finished', 'error'), '出错');
  assertEquals(getStatusLabel('pending', null), '等待评测');
  assertEquals(getStatusLabel('unknown', null), 'unknown');
});

Deno.test('getLanguageLabel: 已知语言映射，未知原样返回', () => {
  assertEquals(getLanguageLabel('cpp'), 'C++');
  assertEquals(getLanguageLabel('java'), 'Java');
  assertEquals(getLanguageLabel('ui'), '界面参数');
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

Deno.test('formatDateTime: 固定 ISO 输出固定字符串（与进程时区无关）', () => {
  // 断言字面量而非"包含年份"，这样进程时区为 UTC 或 Asia/Shanghai 时都会暴露差异。
  assertEquals(formatDateTime('2026-08-17T00:00:00Z'), '2026/08/17 08:00:00');
  // 带偏移量的输入等价于同一时刻，输出必须一致
  assertEquals(formatDateTime('2026-08-17T08:00:00+08:00'), '2026/08/17 08:00:00');
  // UTC 跨日：UTC 16:30 已是北京时间次日 00:30（跨年）
  assertEquals(formatDateTime('2026-12-31T16:30:00Z'), '2027/01/01 00:30:00');
  // UTC 与北京时间同日但时刻不同，防止回退成 UTC 展示
  assertEquals(formatDateTime('2026-03-01T15:59:59Z'), '2026/03/01 23:59:59');
});

Deno.test('getResultDef: 已知/未知状态返回定义', () => {
  assertEquals(getResultDef('finished').label, '已评测');
  assertEquals(getResultDef('finished').class, 'accepted');
  assertEquals(getResultDef('error').label, '出错');
  assertEquals(getResultDef('Nope').label, 'Nope');
  assertEquals(getResultDef(undefined).label, '未知');
});

Deno.test('submissionVersionLabel: 版本号优先，未知历史版本显式标注', () => {
  assertEquals(
    submissionVersionLabel({ version_origin: 'known', submitted_version: 3 }),
    'v3',
  );
  // 迁移前提交：来源为 legacy_unknown，绝不能显示成 v0 或留空
  assertEquals(
    submissionVersionLabel({ version_origin: 'legacy_unknown', submitted_version: null }),
    '未知历史版本',
  );
  // 版本行已被删除（来源已知但版本号取不到）与"未知历史"区分开
  assertEquals(
    submissionVersionLabel({ version_origin: 'known', submitted_version: null }),
    '版本已删除',
  );
  assertEquals(submissionVersionLabel({}), '未知历史版本');
});
