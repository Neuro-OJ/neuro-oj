/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { classroomImportResultCsv } from '../utils/education-enrollment.ts';
import type { ClassroomImportRow } from '../utils/education-enrollment.ts';

Deno.test('入班 CSV 结果：保护电子表格公式，只输出当前响应实际提供的邀请链接', () => {
  const row: ClassroomImportRow = {
    row: 2,
    email: '=calc@example.com',
    username: '@student',
    matched_username: null,
    user_id: null,
    action: 'invite',
    invitation_ids: [],
    token: 'token',
  };
  const first = classroomImportResultCsv([row], (token) => `https://noj.example/join#invitation=${token}`);
  assertEquals(first.startsWith('\uFEFF'), true);
  assertEquals(first.includes('"\'=calc@example.com"'), true);
  assertEquals(first.includes('"\'@student"'), true);
  assertEquals(first.includes('/join#invitation=token'), true);
  const replay = classroomImportResultCsv([{ ...row, token: undefined }], () => {
    throw new Error('重试不能恢复令牌');
  });
  assertEquals(replay.includes('invitation='), false);
});
