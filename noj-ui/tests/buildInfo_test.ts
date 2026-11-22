/**
 * 构建身份展示格式化测试。
 *
 * 页脚技术信息条同时展示前端与后端三要素，这里钉住两端共用的格式化规则：
 * 版本补 `v` 前缀、commit 取前 7 位且保留 `-dirty`、时间按指定时区渲染并带时区标识、
 * 任何缺失/非法值降级为 `unknown` 且不抛错。
 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  buildInfoText,
  commitDisplay,
  commitFull,
  formatBuiltAt,
  normalizeVersion,
  UNKNOWN_TEXT,
} from '../utils/buildInfo.ts';

Deno.test('buildInfo: 版本号归一化为 Release tag 形态', () => {
  assertEquals(normalizeVersion('0.10.1-beta.2'), 'v0.10.1-beta.2');
  assertEquals(normalizeVersion('v0.10.1-beta.2'), 'v0.10.1-beta.2');
  assertEquals(normalizeVersion(' 1.2.3 '), 'v1.2.3');
  assertEquals(normalizeVersion(''), UNKNOWN_TEXT);
  assertEquals(normalizeVersion(null), UNKNOWN_TEXT);
  assertEquals(normalizeVersion(UNKNOWN_TEXT), UNKNOWN_TEXT);
});

Deno.test('buildInfo: commit 取前 7 位并保留 -dirty 后缀', () => {
  assertEquals(commitDisplay('4b7e3e2a9'), '4b7e3e2');
  assertEquals(commitDisplay('4b7e3e2a9-dirty'), '4b7e3e2-dirty');
  assertEquals(
    commitDisplay('0123456789abcdef0123456789abcdef01234567'),
    '0123456',
  );
  assertEquals(commitDisplay(null), UNKNOWN_TEXT);
  assertEquals(commitDisplay(''), UNKNOWN_TEXT);
  assertEquals(commitDisplay(UNKNOWN_TEXT), UNKNOWN_TEXT);
});

Deno.test('buildInfo: commitFull 去掉 -dirty 供 title 与链接使用', () => {
  assertEquals(commitFull('4b7e3e2a9-dirty'), '4b7e3e2a9');
  assertEquals(commitFull('4b7e3e2a9'), '4b7e3e2a9');
  assertEquals(commitFull(null), null);
  assertEquals(commitFull('-dirty'), null);
});

Deno.test('buildInfo: 构建时间按指定时区渲染并带时区标识', () => {
  // 固定时区断言：CI/服务器时区不同也不会让测试漂移
  assertEquals(
    formatBuiltAt('2026-09-27T12:00:00Z', 'Asia/Shanghai'),
    '2026-09-27 20:00 GMT+8',
  );
  assertEquals(
    formatBuiltAt('2026-09-27T12:00:00Z', 'UTC'),
    '2026-09-27 12:00 UTC',
  );
});

Deno.test('buildInfo: 时间缺失或非法降级为 unknown', () => {
  assertEquals(formatBuiltAt(null), UNKNOWN_TEXT);
  assertEquals(formatBuiltAt(''), UNKNOWN_TEXT);
  assertEquals(formatBuiltAt('not-a-date'), UNKNOWN_TEXT);
  assertEquals(formatBuiltAt(UNKNOWN_TEXT), UNKNOWN_TEXT);
});

Deno.test('buildInfo: 纯文本行由三要素拼接，缺失值保持位置', () => {
  assertEquals(
    buildInfoText({
      version: '0.10.1-beta.2',
      commit: '4b7e3e2a9-dirty',
      builtAt: '2026-09-27T12:00:00Z',
    }).startsWith('v0.10.1-beta.2 · 4b7e3e2-dirty · 2026-09-27'),
    true,
  );
  assertEquals(
    buildInfoText({ version: '', commit: null, builtAt: 'bad' }),
    'unknown · unknown · unknown',
  );
});
