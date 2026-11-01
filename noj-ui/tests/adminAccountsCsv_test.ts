// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import { credentialsCsv, parseAccountCsv } from '../utils/adminAccountsCsv.ts';

Deno.test('adminAccountsCsv: BOM、CRLF、空字段及最多 500 行', () => {
  assertEquals(
    parseAccountCsv('\uFEFFusername,email,password\r\nstudent01,,\r\nstudent02,student@example.com,Initial2026A\r\n'),
    [
      { username: 'student01', email: undefined, password: undefined },
      { username: 'student02', email: 'student@example.com', password: 'Initial2026A' },
    ],
  );
  assertEquals(
    parseAccountCsv('username,email,password\n' + Array.from({ length: 500 }, (_, i) => `student${i},,`).join('\n'))
      .length,
    500,
  );
  assertEquals(parseAccountCsv('username,email,password\n,,')[0]?.username, '');
});

Deno.test('adminAccountsCsv: 导出并重新解析时保留密码中的逗号、引号、换行与空格', () => {
  const credentials = [{ username: 'student01', email: 'student@example.com', password: ' A1b,"quoted"\npassword ' }];
  assertEquals(parseAccountCsv(credentialsCsv(credentials)), credentials);
});

Deno.test('adminAccountsCsv: 拒绝错误表头、列数、引号、空批和超限', () => {
  for (
    const csv of [
      'username,password\nstu,Pass123A',
      'username,email,password\nstu,email',
      'username,email,password\nstu,,"Unclosed',
      'username,email,password\nstu,,"closed"junk',
      'username,email,password\n',
      'username,email,password\n' + Array.from({ length: 501 }, (_, i) => `student${i},,`).join('\n'),
    ]
  ) assertThrows(() => parseAccountCsv(csv));
});
