import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, watch } from 'vue';
import ObjectiveRichText from '~/components/objective/ObjectiveRichText.vue';
import MarkdownRenderer from '~/components/shared/MarkdownRenderer.vue';

// 组件测试环境没有 Nuxt 自动导入：MarkdownRenderer 运行时引用的全局标识符在此补齐。
// happy-dom 下 DOMPurify 会剥掉全部标签（`<p>hi</p>` → `hi`），无法反映浏览器行为，
// 因此净化替换为直通，本测试只断言 Markdown 表格 / KaTeX 的渲染结果。
Object.assign(globalThis, {
  ref,
  watch,
  sanitizeHtmlAsync: (raw: string) => Promise.resolve(raw),
});

async function render(content: string) {
  const wrapper = mount(ObjectiveRichText, {
    props: { content },
    global: { components: { MarkdownRenderer } },
  });
  // 渲染经 watch + async 净化后写入，等待内容落地
  await vi.waitFor(() => expect(wrapper.element.innerHTML).not.toBe(''));
  return wrapper;
}

describe('ObjectiveRichText', () => {
  it('渲染 Markdown 表格', async () => {
    const wrapper = await render('| 输入 | 输出 |\n| --- | --- |\n| 1 | 2 |');
    const table = wrapper.find('table');
    expect(table.exists()).toBe(true);
    expect(table.findAll('th').map((th) => th.text())).toEqual(['输入', '输出']);
    expect(table.findAll('td').map((td) => td.text())).toEqual(['1', '2']);
  });

  it('渲染行内与独立行 LaTeX 公式', async () => {
    const wrapper = await render('已知 $x^2$，求\n\n$$\\sum_{i=1}^n i$$');
    expect(wrapper.findAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find('.katex-display').exists()).toBe(true);
  });

  it('净化剥离 style 时 KaTeX 排版样式仍保留（公式在净化之后回填）', async () => {
    // 模拟生产 DOMPurify 的 FORBID_ATTR: ['style']
    const original = (globalThis as Record<string, unknown>).sanitizeHtmlAsync;
    (globalThis as Record<string, unknown>).sanitizeHtmlAsync = (raw: string) =>
      Promise.resolve(raw.replace(/\sstyle="[^"]*"/g, ''));
    try {
      const wrapper = await render('$$\\frac{a}{b}$$');
      expect(wrapper.find('.katex-display .mfrac').exists()).toBe(true);
      expect(wrapper.findAll('.katex [style]').length).toBeGreaterThan(0);
    } finally {
      (globalThis as Record<string, unknown>).sanitizeHtmlAsync = original;
    }
  });

  it('属性值中的公式占位符不回填（防止属性逃逸）', async () => {
    const wrapper = await render('<abbr title="$x$">缩写</abbr> 与 $y$');
    expect(wrapper.find('abbr').attributes('title')).not.toContain('katex');
    expect(wrapper.find('abbr').attributes('title')).not.toMatch(/NOJKATEX/);
    // 正文中的公式照常渲染
    expect(wrapper.findAll('.katex').length).toBe(1);
  });

  it('使用紧凑排版类', async () => {
    const wrapper = await render('A');
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['prose', 'prose-sm']));
  });
});
