/**
 * utils/validatePassword.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import { validateEmail, validatePassword, validatePasswordMatch } from '../utils/validatePassword.ts';

Deno.test('validatePassword: 空值、长度与字符组成校验', () => {
  assertEquals(validatePassword(''), { valid: false, message: '请输入密码' });
  assertEquals(validatePassword('short'), { valid: false, message: '密码长度不能少于 8 位' });
  assertEquals(validatePassword('UPPERCASE1234'), { valid: false, message: '密码必须包含至少一个小写字母' });
  assertEquals(validatePassword('lowercase1234'), { valid: false, message: '密码必须包含至少一个大写字母' });
  assertEquals(validatePassword('LowercaseLetters'), { valid: false, message: '密码必须包含至少一个数字' });
  assertEquals(validatePassword('Aa123456'), { valid: true, message: '' });
  assertEquals(validatePassword('ValidPass1234'), { valid: true, message: '' });
});

Deno.test('validatePassword: 用户名与邮箱前缀限制', () => {
  assertEquals(validatePassword('Aa123456', { username: 'Aa123456' }), {
    valid: false,
    message: '密码不能与用户名相同',
  });
  assertEquals(validatePassword('Aa123456', { email: 'Aa123456@example.com' }), {
    valid: false,
    message: '密码不能与邮箱前缀相同',
  });
  assertEquals(validatePassword('Aa123456', { username: 'other', email: 'other@example.com' }), {
    valid: true,
    message: '',
  });
});

Deno.test('validatePasswordMatch: 空确认与不一致', () => {
  assertEquals(validatePasswordMatch('a', ''), '请确认密码');
  assertEquals(validatePasswordMatch('a', 'b'), '两次输入的密码不一致');
  assertEquals(validatePasswordMatch('a', 'a'), null);
});

Deno.test('validateEmail: 空值、非法格式与合法格式', () => {
  assertEquals(validateEmail(''), '请输入邮箱地址');
  assertEquals(validateEmail('  '), '请输入邮箱地址');
  assertEquals(validateEmail('bad'), '邮箱格式不正确');
  assertEquals(validateEmail('a@b.com'), null);
});
