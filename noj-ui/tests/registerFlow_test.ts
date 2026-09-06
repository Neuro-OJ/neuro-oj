/**
 * utils/registerFlow.ts 回归测试（issue #425 / #426）。
 *
 * 覆盖注册提交流程的四个分支：
 * - 邮件发送成功：跳转 /verify-email?registered=1&sent=1
 * - 注册成功但邮件未发出：跳转 /verify-email?registered=1&sent=0
 * - 自动登录失败：引导手动登录 /login?registered=1
 * - 注册接口失败：错误向调用方传播（由页面统一提示）
 *
 * 回归背景（#425）：`sent` 曾声明在注册 try 块内，自动登录成功后
 * 引用未定义变量抛错，被 catch 误判为登录失败跳到 /login?registered=1。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { submitRegistration } from '../utils/registerFlow.ts';

Deno.test('submitRegistration: 邮件发送成功时跳转 sent=1', async () => {
  const calls: string[] = [];
  const result = await submitRegistration(
    {
      register: () => {
        calls.push('register');
        return Promise.resolve(true);
      },
      login: () => {
        calls.push('login');
        return Promise.resolve({});
      },
    },
    'alice',
    'alice@example.com',
    'Passw0rd-X',
  );
  assertEquals(calls, ['register', 'login']);
  assertEquals(result, {
    status: 'verified',
    destination: '/verify-email?registered=1&sent=1',
  });
});

Deno.test('submitRegistration: 注册成功但邮件未发出时跳转 sent=0', async () => {
  const result = await submitRegistration(
    {
      register: () => Promise.resolve(false),
      login: () => Promise.resolve({}),
    },
    'alice',
    'alice@example.com',
    'Passw0rd-X',
  );
  assertEquals(result, {
    status: 'resend_needed',
    destination: '/verify-email?registered=1&sent=0',
  });
});

Deno.test('submitRegistration: 自动登录失败时引导手动登录', async () => {
  const result = await submitRegistration(
    {
      register: () => Promise.resolve(true),
      login: () => Promise.reject(new Error('bad credentials')),
    },
    'alice',
    'alice@example.com',
    'Passw0rd-X',
  );
  assertEquals(result, {
    status: 'login_failed',
    destination: '/login?registered=1',
  });
});

Deno.test('submitRegistration: 注册接口失败时错误向调用方传播', async () => {
  await assertRejects(
    () =>
      submitRegistration(
        {
          register: () => Promise.reject(new Error('用户名已存在')),
          login: () => Promise.resolve({}),
        },
        'alice',
        'alice@example.com',
        'Passw0rd-X',
      ),
    Error,
    '用户名已存在',
  );
});
