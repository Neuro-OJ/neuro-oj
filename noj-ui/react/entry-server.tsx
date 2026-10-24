/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { App } from './App.tsx';
import type { Bootstrap } from './types.ts';

/** 静态 Tailwind 样式随应用构建输出，SSR 不创建进程级样式缓存。 */
export function renderReact(bootstrap: Bootstrap): { html: string } {
  return {
    html: renderToString(
      <StaticRouter basename='/react' location={bootstrap.url}>
        <App bootstrap={bootstrap} />
      </StaticRouter>,
      { identifierPrefix: 'noj-react-' },
    ),
  };
}
