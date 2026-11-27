import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, watch } from 'vue';
import sanitizeHtml from 'sanitize-html';
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue';
import { buildServerOptions } from '~/utils/sanitize-policy';

beforeEach(() => {
  vi.clearAllMocks();
  const sanitizeWithPolicy = (raw: string, input?: { allowExternalImages?: boolean }) =>
    Promise.resolve(
      sanitizeHtml(raw, buildServerOptions({ allowExternalImages: input?.allowExternalImages === true })),
    );
  for (
    const [name, value] of Object.entries({
      ref,
      watch,
      sanitizeHtmlAsync: sanitizeWithPolicy,
      sanitizeHtmlSync: (raw: string) => sanitizeHtml(raw, buildServerOptions({ allowExternalImages: false })),
    })
  ) {
    vi.stubGlobal(name, value);
  }
});

describe('MarkdownRenderer 按需高亮、公式与净化', () => {
  it('按需注册的常用语言可正常语法高亮，未知语言安全转义', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```python',
          'def solve(x):',
          '    return x + 1',
          '```',
          '',
          '```unknownlang',
          '<script>alert(1)</script>',
          '```',
        ].join('\n'),
      },
    });
    await vi.waitFor(() => expect(wrapper.element.innerHTML).not.toBe(''));

    const html = wrapper.html();
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('def');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    wrapper.unmount();
  });

  it('行内与块级 KaTeX 公式穿过净化后正常回填且阻断 XSS', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '公式 $a^2 + b^2 = c^2$ 以及 <img src="x" onerror="alert(1)">',
      },
    });
    await vi.waitFor(() => expect(wrapper.element.innerHTML).not.toBe(''));

    const html = wrapper.html();
    expect(html).toContain('katex');
    expect(html).not.toContain('onerror');
    wrapper.unmount();
  });
});
