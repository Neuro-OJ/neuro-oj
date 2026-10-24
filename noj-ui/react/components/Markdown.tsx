/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { useEffect, useMemo, useState } from 'react';
import { renderMarkdownAsync, renderMarkdownSync } from '../../utils/markdownRender.ts';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

export function Markdown({ content }: { content: string }) {
  const initialHtml = useMemo(() => renderMarkdownSync(content), [content]);
  const [rendered, setRendered] = useState<{ source: string; html: string } | null>(null);
  useEffect(() => {
    let active = true;
    void renderMarkdownAsync(content).then((html) => {
      if (active) setRendered({ source: content, html });
    });
    return () => {
      active = false;
    };
  }, [content]);
  return (
    <div
      className='prose prose-neuro max-w-none break-words'
      dangerouslySetInnerHTML={{ __html: rendered?.source === content ? rendered.html : initialHtml }}
    />
  );
}
