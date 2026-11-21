<script setup lang="ts">
import type { DomainProblemContent } from '~/utils/domain-problems';
defineProps<{ samples: DomainProblemContent['samples'] }>();
const { copyText } = useCopyText();
const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopy(key: string, value: string, label: string) {
  await copyText(value, label);
  copiedKey.value = key;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedKey.value = null; }, 1500);
}

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>
<template>
  <section v-for="(sample,index) in samples" :key="index" class="mt-6 border-t border-border pt-5">
    <h2 class="mb-3 text-base font-semibold text-text">样例 {{ index + 1 }}</h2>
    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <div v-for="part in [{key:'in',label:'输入',value:sample.input},{key:'out',label:'输出',value:sample.output}]" :key="part.key"
        class="min-w-0 overflow-hidden rounded-md border border-border bg-bg-panel">
        <div class="flex items-center justify-between border-b border-border bg-bg-sunken/70 px-3 py-1.5 text-xs text-text-secondary">
          <span class="font-medium">{{ part.label }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="copiedKey === `${index}:${part.key}` ? 'i-lucide-check' : 'i-lucide-copy'"
            :class="copiedKey === `${index}:${part.key}` ? 'text-signal' : ''"
            :aria-label="`复制样例${index+1}${part.label}`"
            @click="handleCopy(`${index}:${part.key}`, part.value, part.label)"
          />
        </div>
        <pre class="overflow-auto p-3 font-mono text-xs leading-relaxed text-text">{{ part.value }}</pre>
      </div>
    </div>
    <MarkdownRenderer v-if="sample.explanation" class="mt-3" :content="sample.explanation" />
  </section>
</template>
