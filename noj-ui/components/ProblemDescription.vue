<script setup lang="ts">
import markdownit from "markdown-it"
import katex from "katex"
import "katex/dist/katex.min.css"
import hljs from "highlight.js"
import "highlight.js/styles/github-dark.css"

const props = defineProps<{ content: string }>()

const md = markdownit({
  html: true, // 保留 KaTeX 生成的 HTML（LaTeX 渲染在 md.render 之前完成）
  breaks: true,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch (_) {
        // fall through
      }
    }
    return `<pre class="hljs"><code>${md.utils?.escapeHtml?.(str) ?? str}</code></pre>`
  },
})

function renderMarkdown(src: string): string {
  // 1. 提取代码块，用占位符替换
  const codeBlocks: string[] = []
  let text = src.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  // 2. 块级 LaTeX $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false })
    } catch {
      return `$$\n${math}\n$$`
    }
  })

  // 3. 行内 LaTeX $...$（不匹配 \$ 转义符，允许 \\. 转义序列）
  text = text.replace(/(?<!\$)(?<!\\)\$([^$\\\n]+?)\$(?!\$)(?!\\)/g, (_match, math: string) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false })
    } catch {
      return `$${math}$`
    }
  })

  // 4. 恢复代码块
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx: string) => codeBlocks[Number(idx)])

  // 5. 渲染 Markdown
  return md.render(text)
}

// DOMPurify sanitize（防止 v-html XSS）
// 客户端懒加载，SSR 时直接渲染（次优但安全——题目内容来自数据库非用户输入）
const renderedHtml = ref("")

if (import.meta.client) {
  import("dompurify").then((mod) => {
    const purify = mod.default
    watch(
      () => props.content,
      (content) => {
        const raw = renderMarkdown(content)
        renderedHtml.value = purify.sanitize(raw)
      },
      { immediate: true },
    )
  }).catch(() => {
    // DOMPurify 失败时降级直接渲染
    watch(
      () => props.content,
      (content) => {
        renderedHtml.value = renderMarkdown(content)
      },
      { immediate: true },
    )
  })
} else {
  // SSR — 直接渲染（无 DOM 环境，DOMPurify 不可用）
  watch(
    () => props.content,
    (content) => {
      renderedHtml.value = renderMarkdown(content)
    },
    { immediate: true },
  )
}
</script>

<template>
  <div class="noj-md-render" v-html="renderedHtml" />
</template>

<!--
  v-html 渲染的内容不在 Vue 的 scoped CSS 作用域内，
  因此这里不使用 scoped，改用 .noj-md-render 类名前缀避免污染全局。
-->
<style>
.noj-md-render {
  font-size: 15px;
  line-height: 1.7;
  color: var(--c-text);
  word-wrap: break-word;
}

.noj-md-render h1 { font-size: 1.6em; font-weight: 700; margin: 1.2em 0 0.6em; }
.noj-md-render h2 { font-size: 1.35em; font-weight: 700; margin: 1.1em 0 0.5em; }
.noj-md-render h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.4em; }
.noj-md-render p { margin: 0.6em 0; }
.noj-md-render p:first-child { margin-top: 0; }
.noj-md-render ul,
.noj-md-render ol { padding-left: 1.6em; margin: 0.5em 0; }
.noj-md-render li { margin: 0.25em 0; }
.noj-md-render li > ul,
.noj-md-render li > ol { margin: 0.2em 0; }

/* Inline code */
.noj-md-render code:not(.hljs code) {
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 0.88em;
  color: #be123c;
}

/* Code blocks (highlight.js) */
.noj-md-render pre {
  margin: 0.8em 0;
  border-radius: 8px;
  overflow-x: auto;
  background: #0d1117;
}

.noj-md-render pre code {
  padding: 16px;
  font-size: 13px;
  line-height: 1.5;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
}

/* Blockquotes */
.noj-md-render blockquote {
  border-left: 3px solid var(--c-primary);
  padding: 0.5em 1em;
  margin: 0.8em 0;
  background: var(--c-primary-bg);
  color: var(--c-text-secondary);
  border-radius: 0 6px 6px 0;
}

/* Tables */
.noj-md-render table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
  font-size: 14px;
}

.noj-md-render th,
.noj-md-render td {
  border: 1px solid var(--c-border);
  padding: 8px 12px;
  text-align: left;
}

.noj-md-render th {
  background: #f8fafc;
  font-weight: 600;
}

/* Horizontal rule */
.noj-md-render hr {
  border: none;
  border-top: 1px solid var(--c-border);
  margin: 1.2em 0;
}

/* Links */
.noj-md-render a {
  color: var(--c-primary);
  text-decoration: none;
}

.noj-md-render a:hover {
  text-decoration: underline;
}

/* KaTeX fix — 防止 math 溢出 */
.noj-md-render .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 0;
}

.noj-md-render .katex {
  font-size: 1.05em;
}
</style>
