<script lang="ts">
import markdownit from 'markdown-it';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/github-dark.css';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import latex from 'highlight.js/lib/languages/latex';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// 按需注册竞赛与 AI 领域高频语言，避免全量打包 highlight.js 全部 ~190 种语言定义
const REGISTERED_LANGUAGES = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['http', http],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['latex', latex],
  ['makefile', makefile],
  ['markdown', markdown],
  ['plaintext', plaintext],
  ['python', python],
  ['r', r],
  ['rust', rust],
  ['shell', shell],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
] as const;

for (const [name, definition] of REGISTERED_LANGUAGES) {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, definition);
  }
}

// 模块级单例：列表页同时挂载多条评论/公告时避免重复构造 markdown-it 实例
const md = markdownit({
  html: true,
  breaks: true,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`;
      } catch (_) { /* fall through */ }
    }
    return `<pre class="hljs"><code>${md.utils?.escapeHtml?.(str) ?? str}</code></pre>`;
  },
});

/**
 * 渲染 Markdown，并把 LaTeX 公式替换为占位符。
 *
 * KaTeX 依赖内联 style（height / top / vertical-align）定位分式、上下标等，
 * 而 DOMPurify 配置了 FORBID_ATTR: ['style']；若先渲染公式再净化，样式被剥掉，
 * 分式与上下标排版错乱。因此公式以占位符穿过 Markdown 与净化，净化后再回填
 * KaTeX 输出（KaTeX 默认 trust=false，不会产出 \href / \htmlStyle 等可信指令）。
 */
function renderMarkdown(src: string): { html: string; formulas: string[]; nonce: string } {
  // 无公式的纯文本/代码片段直接跳过占位符与 LaTeX 正则扫描
  if (!src.includes('$')) {
    return { html: md.render(src), formulas: [], nonce: '' };
  }

  // 占位符只含字母数字（不受 Markdown / linkify 影响），nonce 防止与正文撞车
  const nonce = Math.random().toString(36).slice(2, 10);
  const formulas: string[] = [];
  const placeholder = (html: string) => {
    formulas.push(html);
    return `NOJKATEX${nonce}X${formulas.length - 1}X`;
  };

  // 1. 提取代码块，用占位符替换
  const codeBlocks: string[] = [];
  let text = src.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // 2. 块级 LaTeX $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return placeholder(katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }));
    } catch {
      return `$$\n${math}\n$$`;
    }
  });

  // 3. 行内 LaTeX $...$
  text = text.replace(/(?<!\$)(?<!\\)\$([^$\n]+?)\$(?!\$)(?!\\)/g, (_match, math: string) => {
    try {
      return placeholder(katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }));
    } catch {
      return `$${math}$`;
    }
  });

  // 4. 恢复代码块
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx: string) => codeBlocks[Number(idx)] ?? '');

  // 5. 渲染 Markdown
  return { html: md.render(text), formulas, nonce };
}

/**
 * 净化后回填 KaTeX 公式。
 * 只在文本节点位置回填；落在标签内（如属性值 `<a title="$x$">`）的占位符直接丢弃，
 * 避免把 KaTeX HTML 注入属性造成属性逃逸。
 */
function restoreFormulas(html: string, formulas: string[], nonce: string): string {
  if (formulas.length === 0) return html;
  const pattern = new RegExp(`NOJKATEX${nonce}X(\\d+)X`, 'g');
  return html
    .split(/(<[^>]*>)/g)
    .map((part) =>
      part.startsWith('<')
        ? part.replace(pattern, '')
        : part.replace(pattern, (_match, idx: string) => formulas[Number(idx)] ?? '')
    )
    .join('');
}
</script>

<script setup lang="ts">
const { content, allowExternalImages = false } = defineProps<{
  content: string;
  allowExternalImages?: boolean;
}>();

// DOMPurify sanitize（防止 v-html XSS）
// 客户端优先使用 DOMPurify，加载失败时使用标签白名单降级
const renderedHtml = ref('');
let renderId = 0;

watch(
  [() => content, () => allowExternalImages],
  async ([source, imagesAllowed]) => {
    const id = ++renderId;
    const { html: rendered, formulas, nonce } = renderMarkdown(source);
    // 图片处置（站内相对保留、非 https 降级为链接、未知协议丢弃）由净化政策的
    // 解析器回调执行 —— 不再用正则重写标签：正则无法可靠复现浏览器的实体与
    // 属性解析规则（2026-11-02 审计 F1）。
    const sanitizeOptions = { allowExternalImages: imagesAllowed === true };
    const sanitized = import.meta.client
      ? await sanitizeHtmlAsync(rendered, sanitizeOptions)
      : sanitizeHtmlSync(rendered, sanitizeOptions);
    const html = restoreFormulas(sanitized, formulas, nonce);
    // 只应用最新的渲染结果，防止 async 完成顺序错乱
    if (id === renderId) renderedHtml.value = html;
  },
  { immediate: true },
);
</script>

<template>
  <div class="prose prose-neuro max-w-none" v-html="renderedHtml" />
</template>
