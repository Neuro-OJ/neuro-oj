/** utils/contestMutation.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { runContestMutation } from '../utils/contestMutation.ts';

function createOptions(overrides: Partial<Parameters<typeof runContestMutation>[0]> = {}) {
  let saving = false;
  const events: string[] = [];
  const options: Parameters<typeof runContestMutation>[0] = {
    isSaving: () => saving,
    setSaving: (value) => {
      saving = value;
      events.push(value ? 'saving' : 'idle');
    },
    save: () => {
      events.push('save');
      return Promise.resolve();
    },
    onSaved: () => {
      events.push('saved');
    },
    refresh: () => {
      events.push('refresh');
      return Promise.resolve(true);
    },
    onRefreshFailed: () => {
      events.push('refresh-failed');
    },
    ...overrides,
  };
  return { options, events, getSaving: () => saving };
}

Deno.test('contestMutation: 保存成功后先反馈再刷新，并在结束时解锁', async () => {
  const { options, events, getSaving } = createOptions();

  const result = await runContestMutation(options);

  assertEquals(result, true);
  assertEquals(events, ['saving', 'save', 'saved', 'refresh', 'idle']);
  assertEquals(getSaving(), false);
});

Deno.test('contestMutation: 刷新失败不会重新判定保存失败', async () => {
  const { options, events } = createOptions({
    refresh: () => {
      events.push('refresh');
      return Promise.resolve(false);
    },
  });

  const result = await runContestMutation(options);

  assertEquals(result, true);
  assertEquals(events, ['saving', 'save', 'saved', 'refresh', 'refresh-failed', 'idle']);
});

Deno.test('contestMutation: 保存失败不会反馈成功或刷新列表', async () => {
  const { options, events, getSaving } = createOptions({
    save: () => {
      events.push('save');
      return Promise.reject(new Error('save failed'));
    },
  });

  await assertRejects(() => runContestMutation(options), Error, 'save failed');

  assertEquals(events, ['saving', 'save', 'idle']);
  assertEquals(getSaving(), false);
});

Deno.test('contestMutation: 网络异常但服务端已保存时恢复为成功', async () => {
  const { options, events } = createOptions({
    save: () => {
      events.push('save');
      return Promise.reject(new TypeError('Failed to fetch'));
    },
    recover: () => {
      events.push('recover');
      return Promise.resolve(true);
    },
  });

  const result = await runContestMutation(options);

  assertEquals(result, true);
  assertEquals(events, ['saving', 'save', 'recover', 'saved', 'refresh', 'idle']);
});

Deno.test('contestMutation: 保存进行中时重复调用直接跳过', async () => {
  const { options, events } = createOptions();
  options.setSaving(true);

  const result = await runContestMutation(options);

  assertEquals(result, false);
  assertEquals(events, ['saving']);
});
