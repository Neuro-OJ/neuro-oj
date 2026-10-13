<script setup lang="ts">
import { workspaceProblemPath } from '~/utils/workspace';
const api = useDomainProblems(), { user } = useAuth();
async function sample() {
  try {
    const first = await api.list('main', 1);
    const page = Math.floor(Math.random() * Math.max(1, Math.ceil(first.total / 30))) + 1;
    const result = page === 1 ? first : await api.list('main', page);
    return result.items.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  } catch {
    return [];
  }
}
const { data, status, refresh } = await useAsyncData(
  () => `public-random-problems:main:${user.value?.id ?? 'guest'}`,
  sample,
);
</script>
<template>
  <UCard class="h-full">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h3 class="font-semibold">随机题目</h3>
      <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="换一批题目" :loading="status === 'pending'"
        @click="refresh()" />
    </div>
    <div class="space-y-3">
      <NuxtLink v-for="problem in data" :key="problem.reference.problem_id"
        :to="workspaceProblemPath('main', problem.reference.display_ref)"
        class="block rounded border border-border p-3 transition-colors hover:border-primary">
        <span class="mr-2 font-mono text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}
        <p class="mt-1 text-xs text-text-muted">V{{ problem.version }} · {{ { oi: 'OI 编程题', ai: 'AI 代码／LLM／产物题', objective: '客观题' }[problem.kind] }}</p>
      </NuxtLink>
      <p v-if="status !== 'pending' && !data?.length" class="text-sm text-text-muted">暂无可浏览的公开题目</p>
    </div>
    <UButton to="/d/main/problems" variant="ghost" class="mt-4">查看全部题目</UButton>
  </UCard>
</template>
