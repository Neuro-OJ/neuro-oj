/** utils/codeEditorTemplate.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { restoreCodeTemplate } from '../utils/codeEditorTemplate.ts';

function createOptions(overrides: Partial<Parameters<typeof restoreCodeTemplate>[0]> = {}) {
  const events: string[] = [];
  const options: Parameters<typeof restoreCodeTemplate>[0] = {
    fetchTemplate: () => {
      events.push('fetch');
      return Promise.resolve('print("hello")');
    },
    clearDraft: () => {
      events.push('clear');
    },
    setCode: (template) => {
      events.push(`set:${template}`);
    },
    ...overrides,
  };
  return { options, events };
}

Deno.test('codeEditorTemplate: 模板成功后才清除草稿并替换代码', async () => {
  const { options, events } = createOptions();

  const restored = await restoreCodeTemplate(options);

  assertEquals(restored, true);
  assertEquals(events, ['fetch', 'clear', 'set:print("hello")']);
});

Deno.test('codeEditorTemplate: 空模板不会覆盖现有代码或清除草稿', async () => {
  const { options, events } = createOptions({
    fetchTemplate: () => {
      events.push('fetch');
      return Promise.resolve(null);
    },
  });

  const restored = await restoreCodeTemplate(options);

  assertEquals(restored, false);
  assertEquals(events, ['fetch']);
});

Deno.test('codeEditorTemplate: 模板请求失败时保留原草稿', async () => {
  const { options, events } = createOptions({
    fetchTemplate: () => {
      events.push('fetch');
      return Promise.reject(new Error('template unavailable'));
    },
  });

  await assertRejects(() => restoreCodeTemplate(options), Error, 'template unavailable');
  assertEquals(events, ['fetch']);
});
