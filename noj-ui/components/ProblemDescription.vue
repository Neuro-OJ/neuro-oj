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
  text = text.replace(/(?<!\$)(?<!\\)\$([^$\n]+?)\$(?!\$)(?!\\)/g, (_match, math: string) => {
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
// 客户端优先使用 DOMPurify，加载失败时使用标签白名单降级
const renderedHtml = ref("")
let renderId = 0

watch(
  () => props.content,
  async (content) => {
    const id = ++renderId
    const raw = renderMarkdown(content)
    const html = import.meta.client
      ? await sanitizeHtmlAsync(raw)
      : sanitizeHtmlSync(raw)
    // 只应用最新的渲染结果，防止 async 完成顺序错乱
    if (id === renderId) renderedHtml.value = html
  },
  { immediate: true },
)
</script>

<template>
  <div class="prose prose-neuro max-w-none" v-html="renderedHtml" />
</template>
