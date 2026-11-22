import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import UiFrame from '~/components/uiproblem/UiFrame.vue';

describe('界面题 JSON 消息边界', () => {
  it('init/result/set 将响应式参数和结果转成浏览器可克隆的 JSON 快照', async () => {
    const values = reactive({ prompt: 'before', options: { enabled: true } });
    const result = reactive({ kind: 'self-test' as const, status: 'finished', label: '已评测', score: 100 });
    const wrapper = mount(UiFrame, { props: { html: '<p>题目</p>', values, result } });
    // happy-dom 不加载 srcdoc；明确注入 iframe Window，消息克隆仍由真实 structuredClone 执行。
    const target = window;
    Object.defineProperty(wrapper.find('iframe').element, 'contentWindow', { value: target });
    const messages: unknown[] = [];
    const post = vi.spyOn(target, 'postMessage').mockImplementation((message) => {
      // 浏览器 postMessage 使用 structured clone，直接传 Proxy 会抛 DataCloneError。
      messages.push(structuredClone(message));
    });
    target.dispatchEvent(
      new MessageEvent('message', {
        source: target,
        data: { source: 'noj-ui', type: 'ready' },
      }),
    );
    expect(messages).toEqual([{
      source: 'noj-host',
      type: 'init',
      values: { prompt: 'before', options: { enabled: true } },
      disabled: false,
      title: '',
      result: { kind: 'self-test', status: 'finished', label: '已评测', score: 100 },
    }]);
    result.score = 40;
    await nextTick();
    expect(messages.at(-1)).toEqual({
      source: 'noj-host',
      type: 'result',
      result: { kind: 'self-test', status: 'finished', label: '已评测', score: 40 },
    });
    values.prompt = 'restored';
    await nextTick();
    expect(messages.at(-1)).toEqual({
      source: 'noj-host',
      type: 'set',
      values: { prompt: 'restored', options: { enabled: true } },
    });
    expect((messages[0] as { values: { prompt: string }; result: { score: number } }).values.prompt).toBe('before');
    expect((messages[0] as { result: { score: number } }).result.score).toBe(100);
    wrapper.unmount();
    post.mockRestore();
  });
});
