<script setup lang="ts">
import markdownit from "markdown-it"
import "katex/dist/katex.min.css"
import katex from "katex"
import hljs from "highlight.js"
import "highlight.js/styles/github-dark.css"

const { content, allowExternalImages = false } = defineProps<{
  content: string
  allowExternalImages?: boolean
}>()

const md = markdownit({
  html: true,
  breaks: true,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch (_) { /* fall through */ }
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

  // 3. 行内 LaTeX $...$
  text = text.replace(/(?<!\$)(?<!\\)\$([^$\n]+?)\$(?!\$)(?!\\)/g, (_match, math: string) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false })
    } catch {
      return `$${math}$`
    }
  })

  // 4. 恢复代码块
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx: string) => codeBlocks[Number(idx)] ?? '')

  // 5. 渲染 Markdown
  return md.render(text)
}

function secureExternalImages(html: string): string {
  return html.replace(/<img\b[^>]*?\bsrc=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (tag, dq, sq, nq) => {
    const src = (dq ?? sq ?? nq ?? '').trim()
    // 提取原 alt（若存在）
    const altMatch = tag.match(/\balt=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const rawAlt = altMatch ? (altMatch[1] ?? altMatch[2] ?? altMatch[3] ?? '') : ''
    const altAttr = rawAlt ? ` alt="${md.utils.escapeHtml(rawAlt)}"` : ''

    // 允许站内相对路径（以 / 开头，但不允许协议相对路径 //）
    if (src.startsWith('/') && !src.startsWith('//')) {
      return `<img src="${md.utils.escapeHtml(src)}" loading="lazy"${altAttr}>`
    }
    // 外链只允许 https://
    if (!src.startsWith('https://')) return ''
    if (!allowExternalImages) {
      return `<a href="${md.utils.escapeHtml(src)}" rel="nofollow noopener noreferrer" target="_blank">${rawAlt ? md.utils.escapeHtml(rawAlt) : '外链图片'}</a>`
    }
    return `<img src="${md.utils.escapeHtml(src)}" loading="lazy" referrerpolicy="no-referrer"${altAttr || ' alt="外链图片"'}>`
  })
}

// DOMPurify sanitize（防止 v-html XSS）
// 客户端优先使用 DOMPurify，加载失败时使用标签白名单降级
const renderedHtml = ref("")
let renderId = 0

watch(
  [() => content, () => allowExternalImages],
  async ([source]) => {
    const id = ++renderId
    const raw = secureExternalImages(renderMarkdown(source))
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
