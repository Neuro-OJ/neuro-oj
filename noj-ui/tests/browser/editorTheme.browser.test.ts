/// <reference lib="dom" />
/// <reference lib="deno.ns" />
/**
 * 编辑器主题回归：真实 Chromium 计算 Tailwind、局部主题和 Markdown 的层叠结果。
 * 先启动 UI，再运行 E2E_UI_URL=http://127.0.0.1:3000 deno task test:theme。
 * 通过实际 Domain solve 入口验收；API 全部使用本地夹具，无需启动 core / 数据库。
 */
// deno-lint-ignore no-import-prefix -- 沿用 deno.lock 已固定的浏览器工具版本
import { chromium, expect, type Locator } from 'npm:playwright@1.62.0/test';

const uiUrl = Deno.env.get('E2E_UI_URL') ?? 'http://127.0.0.1:3000';
const screenshotDir = Deno.env.get('NOJ_THEME_SCREENSHOTS');
const description = [
  '# 作业安排 Pro（Python 版）',
  '普通正文：补全作业安排，支持 **优先级** 与 `template.py`。',
  '## 任务背景',
  '- 全清单：所有作业按添加顺序排列。',
  '- 可见行：按条件筛选。',
  '> 提示：保存后可以恢复作业。',
  '[查看说明](/problems/P22)',
  '| 输入 | 输出 |\n| --- | --- |\n| 添加作业 | 作业清单 |',
  '行内公式 $x^2$ 与独立公式：\n\n$$\\frac{a}{b}$$',
  '```python\ndef add(title):\n    return title\n```',
].join('\n\n');

// WCAG 相对亮度；浏览器的计算颜色在本测试中均为不透明 rgb。
function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
      const c = Number(value) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function colors(element: Locator) {
  return await element.evaluate((el) => {
    // 从元素向上合成实际背景，包含引用块的半透明品牌色。
    let node: Element | null = el;
    const layers: number[][] = [];
    while (node) {
      const rgba = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)!.map(Number);
      layers.push([rgba[0]!, rgba[1]!, rgba[2]!, rgba[3] ?? 1]);
      if ((rgba[3] ?? 1) === 1) break;
      node = node.parentElement;
    }
    let rgb = [255, 255, 255];
    for (const layer of layers.reverse()) {
      rgb = rgb.map((c, i) => layer[i]! * layer[3]! + c * (1 - layer[3]!));
    }
    return { foreground: getComputedStyle(el).color, background: `rgb(${rgb.join(',')})` };
  });
}

for (const width of [1440, 390]) {
  Deno.test({
    name: `编辑器主题：${width}px 明暗切换后 Markdown 保持可读`,
    // Playwright 的 Node 兼容层会保留进程级句柄，由 browser.close 负责清理浏览器。
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/api/**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          let body: unknown;
          if (path === '/api/v1/domains/main') {
            body = {
              data: {
                slug: 'main',
                name: 'Main',
                description: '',
                preset: 'public',
                status: 'active',
                visibility: 'public',
                actor_id: null,
                platform_admin: false,
                permissions: [],
                configuration: { features: {} },
              },
            };
          } else if (path === '/api/v1/domains/main/problems/22') {
            body = {
              reference: {
                problem_id: 'uuid-p22',
                source_domain_id: 'main',
                source_domain_slug: 'main',
                number: 22,
                qualified_ref: 'main:22',
                display_ref: 'P22',
                is_shared: false,
              },
              binding_id: 'binding-p22',
              policy_revision: 1,
              effective_version_mode: 'any',
              version_id: 'theme-fixture-v1',
              version: 1,
              can_edit: false,
              supported_languages: ['python3'],
              difficulty: 'hard',
              content: {
                kind: 'ai',
                title: '作业安排 Pro（Python 版）',
                description,
                samples: [],
                submission_mode: 'code',
              },
            };
          } else if (path.endsWith('/template')) {
            body = { data: { content: 'print("hello")', language: 'python3' } };
          } else if (path.endsWith('/ban-status')) {
            body = { ip_banned: false, user_banned: false, authenticated: false };
          } else {
            body = { data: [] };
          }
          await route.fulfill({ json: body });
        });
        await page.goto(`${uiUrl}/d/main/solve/22`);
        if (width < 640) {
          // Domain 编辑器在窄屏默认收起题面；先走真实工具栏交互打开侧栏，再验收其排版。
          await page.getByRole('button', { name: '切换侧栏' }).click();
        }
        const prose = page.locator('.prose-neuro').filter({ has: page.locator('h1') }).last();
        await expect(prose.locator('p').first()).toContainText('普通正文', { timeout: 30_000 });

        // 默认暗色 → 亮色 → 暗色，覆盖初始解析及不重载页面的主题切换。
        for (const theme of ['dark', 'light', 'dark']) {
          const toggle = page.getByRole('button', { name: theme === 'dark' ? '切换到暗色' : '切换到亮色' });
          if (await toggle.count()) await toggle.click();
          const panel = prose.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
          const expectedBackground = theme === 'dark' ? 'rgb(19, 27, 46)' : 'rgb(255, 255, 255)';
          await expect(panel).toHaveCSS('background-color', expectedBackground);
          const expectedText = theme === 'dark' ? 'rgb(248, 250, 252)' : 'rgb(15, 23, 42)';
          await expect(prose.locator('p').first()).toHaveCSS('color', expectedText);
          for (
            const selector of [
              'h1',
              'h2',
              'p',
              'strong',
              'li',
              'a',
              'p code',
              'th',
              'td',
              'blockquote p',
              '.katex',
              'pre code',
            ]
          ) {
            const { foreground, background } = await colors(prose.locator(selector).first());
            // 品牌蓝沿用现有 token；本次不调整色板。
            const minimum = selector === 'a' || selector === 'p code' ? 3 : 4.5;
            expect(contrast(foreground, background), `${theme}: ${selector} 文字对比度`).toBeGreaterThanOrEqual(
              minimum,
            );
          }
          await expect(prose.locator('pre.hljs')).toBeVisible();
          await expect(prose.locator('.katex-display .mfrac')).toBeVisible();
          expect(await prose.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          if (screenshotDir) {
            await Deno.mkdir(screenshotDir, { recursive: true });
            await page.screenshot({ path: `${screenshotDir}/editor-${width}-${theme}.png` });
          }
        }
        expect(errors).toEqual([]);
      } catch (error) {
        if (screenshotDir) {
          await Deno.mkdir(screenshotDir, { recursive: true });
          await browser.contexts()[0]?.pages()[0]?.screenshot({
            path: `${screenshotDir}/editor-${width}-failure.png`,
          });
        }
        throw error;
      } finally {
        await browser.close();
      }
    },
  });
}
