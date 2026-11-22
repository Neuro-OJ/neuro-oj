<script setup lang="ts">
/**
 * 客观题富文本（题干 / 选项 / 解析）：复用 MarkdownRenderer，支持 Markdown 表格与
 * KaTeX 公式（`$...$` / `$$...$$`），HTML 经 DOMPurify 清洗。
 * 紧凑排版：小号字，去掉首尾块元素外边距，便于嵌入选项行。
 */
defineProps<{
  content: string
}>()
</script>

<template>
  <MarkdownRenderer
    :content="content"
    class="prose-sm min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0"
  />
</template>
