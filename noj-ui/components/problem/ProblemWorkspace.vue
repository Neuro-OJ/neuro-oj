<script setup lang="ts">
// 两个面板始终挂载，窄屏切换不会清空代码、答案或已选文件。
const panel = ref<'statement' | 'answer'>('statement');
</script>
<template>
  <div>
    <div class="mb-3 flex gap-2 lg:hidden" role="group" aria-label="做题面板">
      <UButton :variant="panel === 'statement' ? 'solid' : 'outline'" :aria-pressed="panel === 'statement'"
        @click="panel = 'statement'">题面与样例</UButton>
      <UButton :variant="panel === 'answer' ? 'solid' : 'outline'" :aria-pressed="panel === 'answer'"
        @click="panel = 'answer'">作答与自测</UButton>
    </div>
    <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section aria-label="题面与样例" :class="panel === 'statement' ? 'block' : 'hidden'"
        class="min-w-0 space-y-4 lg:block lg:max-h-[calc(100dvh-13rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
        <slot name="statement" />
      </section>
      <section aria-label="作答与自测" :class="panel === 'answer' ? 'block' : 'hidden'"
        class="min-w-0 lg:block lg:max-h-[calc(100dvh-13rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
        <slot name="answer" />
      </section>
    </div>
  </div>
</template>
