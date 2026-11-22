/** utils/contestRegistration.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { runContestRegistration } from '../utils/contestRegistration.ts';

function createOptions(
  overrides: Partial<Parameters<typeof runContestRegistration>[0]> = {},
) {
  let registering = false;
  const events: string[] = [];
  const options: Parameters<typeof runContestRegistration>[0] = {
    isRegistering: () => registering,
    setRegistering: (value) => {
      registering = value;
      events.push(value ? 'registering' : 'idle');
    },
    register: () => {
      events.push('register');
      return Promise.resolve();
    },
    onRegistered: () => {
      events.push('registered');
    },
    refresh: () => {
      events.push('refresh');
      return Promise.resolve();
    },
    onRefreshFailed: () => {
      events.push('refresh-failed');
    },
    ...overrides,
  };
  return { options, events, getRegistering: () => registering };
}

Deno.test('contestRegistration: 报名成功后刷新失败仍保持成功', async () => {
  const { options, events, getRegistering } = createOptions({
    refresh: () => {
      events.push('refresh');
      return Promise.reject(new Error('refresh failed'));
    },
  });

  const result = await runContestRegistration(options);

  assertEquals(result, true);
  assertEquals(events, ['registering', 'register', 'registered', 'refresh', 'refresh-failed', 'idle']);
  assertEquals(getRegistering(), false);
});

Deno.test('contestRegistration: 报名请求失败不会反馈成功或刷新', async () => {
  const { options, events, getRegistering } = createOptions({
    register: () => {
      events.push('register');
      return Promise.reject(new Error('register failed'));
    },
  });

  await assertRejects(() => runContestRegistration(options), Error, 'register failed');

  assertEquals(events, ['registering', 'register', 'idle']);
  assertEquals(getRegistering(), false);
});

Deno.test('contestRegistration: 报名进行中时重复调用直接跳过', async () => {
  const { options, events } = createOptions();
  options.setRegistering(true);

  const result = await runContestRegistration(options);

  assertEquals(result, false);
  assertEquals(events, ['registering']);
});
