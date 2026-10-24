<script setup lang="ts">
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'
import { renderMarkdownAsync, renderMarkdownSync } from '~/utils/markdownRender'

const { content, allowExternalImages = false } = defineProps<{
  content: string
  allowExternalImages?: boolean
}>()

const renderedHtml = ref('')
let renderId = 0
watch(
  [() => content, () => allowExternalImages],
  async ([source]) => {
    const id = ++renderId
    const html = import.meta.client
      ? await renderMarkdownAsync(source, allowExternalImages)
      : renderMarkdownSync(source, allowExternalImages)
    if (id === renderId) renderedHtml.value = html
  },
  { immediate: true },
)
</script>


<template>
  <div class="prose prose-neuro max-w-none" v-html="renderedHtml" />
</template>
