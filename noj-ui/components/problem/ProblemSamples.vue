<script setup lang="ts">
import type { DomainProblemContent } from '~/utils/domain-problems';
const props = defineProps<{ samples: DomainProblemContent['samples']; annotation?: { slug: string; reference: string; version_id: string; contest_id?: string } }>();
function target(index: number, field: string) {
  if (!props.annotation) return undefined;
  const { slug, ...source } = props.annotation;
  return { slug, target: { kind: 'problem' as const, ...source, field: `samples.${index}.${field}` } };
}
const { copyText } = useCopyText();
</script>
<template>
  <section v-for="(sample,index) in samples" :key="index" class="mt-6 border-t border-border pt-5">
    <h2 class="mb-3 text-base font-semibold text-text">样例 {{ index + 1 }}</h2>
    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <div v-for="part in [{label:'输入',field:'input',value:sample.input},{label:'输出',field:'output',value:sample.output}]" :key="part.label"
        class="min-w-0 overflow-hidden rounded border border-border">
        <div class="flex items-center justify-between bg-bg-sunken px-3 py-1.5 text-xs text-text-muted">
          <span>{{ part.label }}</span><UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="`复制样例${index+1}${part.label}`" @click="copyText(part.value,part.label)" />
        </div>
        <AnnotationText :annotation="target(index, part.field)"><pre class="overflow-auto p-3 font-mono text-xs leading-relaxed">{{ part.value }}</pre></AnnotationText>
      </div>
    </div>
    <AnnotationText v-if="sample.explanation" :annotation="target(index, 'explanation')"><MarkdownRenderer class="mt-3" :content="sample.explanation" /></AnnotationText>
  </section>
</template>
