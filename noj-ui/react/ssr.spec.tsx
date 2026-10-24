/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { describe, expect, it } from 'vitest';
import { renderReact } from './entry-server.tsx';
import type { Bootstrap } from './types.ts';

describe('React 服务端渲染边界', () => {
  it('题面与 shadcn 组件首屏输出，Markdown 不执行脚本', () => {
    const bootstrap: Bootstrap = {
      url: '/react/problems/P1',
      user: null,
      resources: {
        '/api/v1/problems/P1': {
          data: {
            data: {
              id: 'p1',
              display_id: 'P1',
              title: '线性回归',
              description: '# 任务\n\n$x^2$\n\n<script>alert(1)</script>',
              difficulty: 'easy',
              type: 'P',
              owner_id: 'u1',
              is_objective: false,
              version: 1,
              version_id: 'v1',
            },
          },
        },
      },
    };
    const rendered = renderReact(bootstrap);
    expect(rendered.html).toContain('线性回归');
    expect(rendered.html).toContain('katex');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('data-slot="card"');
    expect(rendered.html).toContain('/react/editor/P1');
  });

  it('多次 SSR 不会把上一个用户的会话输出到下一次请求', () => {
    const first: Bootstrap = {
      url: '/react',
      user: {
        id: 'a',
        username: 'alice-private-name',
        email: 'a@example.test',
        is_admin: false,
        must_change_password: false,
      },
      resources: {},
    };
    const second: Bootstrap = { url: '/react', user: null, resources: {} };
    expect(renderReact(first).html).toContain('alice-private-name');
    const rendered = renderReact(second);
    expect(rendered.html).not.toContain('alice-private-name');
    expect(rendered.html).toContain('登录以解锁');
    expect(rendered.html).not.toContain('新的练习体验');
    expect(rendered.html).not.toContain('LEARN. BUILD. EVALUATE.');
  });
});
