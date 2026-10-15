<script setup lang="ts">
import { workspaceProblemPath, workspacePath, workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ domainSlug: string }>();
const api = useDomainProblems(), { user } = useAuth();
async function sample() {
  const first = await api.list(props.domainSlug, 1);
  const page = Math.floor(Math.random() * Math.max(1, Math.ceil(first.total / 30))) + 1;
  const result = page === 1 ? first : await api.list(props.domainSlug, page);
  return result.items.slice().sort(() => Math.random() - 0.5).slice(0, 3);
}
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'random-problems'), sample);
</script>
<template>
  <section class="flex h-full min-h-64 flex-col rounded border border-border bg-bg-panel">
    <div class="flex items-center gap-2 border-b border-border px-5 py-3.5">
      <UIcon name="i-lucide-shuffle" class="size-4 text-primary" />
      <h2 class="mr-auto text-sm font-semibold text-text">随机题目</h2>
      <UButton variant="ghost" color="neutral" size="xs" icon="i-lucide-refresh-cw" aria-label="换一批题目" :loading="status === 'pending'" @click="refresh()" />
    </div>
    <div class="flex-1 p-3">
      <AsyncContent :status="error ? 'error' : !data && status === 'pending' ? 'loading' : data?.length ? 'data' : 'empty'"
        :error="error ? extractApiError(error).message : undefined" empty-text="暂无可浏览的题目" @retry="refresh()">
        <ul class="space-y-2">
          <li v-for="problem in data" :key="problem.binding_id">
            <NuxtLink :to="workspaceProblemPath(domainSlug, problem.reference.display_ref)" class="block rounded border border-border p-3 no-underline transition-colors hover:border-primary hover:bg-primary-hover-bg">
              <p class="break-words text-sm font-medium text-text"><span class="mr-2 font-mono text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}</p>
              <div class="mt-2 flex items-center gap-2 text-xs text-text-muted">
                <DifficultyBadge v-if="problem.difficulty" :difficulty="problem.difficulty" />
                <span>{{ { oi:'OI 编程题',ai:'AI 题',objective:'客观题' }[problem.kind] }} · V{{ problem.version }}</span>
              </div>
            </NuxtLink>
          </li>
        </ul>
      </AsyncContent>
    </div>
    <NuxtLink :to="workspacePath(domainSlug,'problems')" class="flex items-center justify-center gap-1 border-t border-border px-5 py-2.5 text-xs font-semibold text-primary no-underline hover:bg-primary-hover-bg">查看全部题目<UIcon name="i-lucide-arrow-right" class="size-3.5" /></NuxtLink>
  </section>
</template>
