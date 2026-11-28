<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';

const props = defineProps<{ domainSlug: string }>();
const { user } = useAuth();
const api = useDomainTrainings();
const key = computed(() => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'home-trainings'));
const { data, error, status, refresh } = await useAsyncData(
  key,
  () => api.list(props.domainSlug, 1, ''),
);
const trainings = computed(() => (data.value?.items ?? []).slice(0, 3));
</script>

<template>
  <section class="overflow-hidden rounded-lg border border-border bg-bg-panel" aria-label="公开题单">
    <div class="flex flex-wrap items-center gap-2 border-b border-border bg-bg-sunken/50 px-3 py-1.5">
      <h2 class="mr-auto text-xs font-semibold text-text-secondary">公开题单</h2>
      <NuxtLink
        :to="workspacePath(domainSlug, 'trainings')"
        class="text-xs text-primary no-underline hover:underline"
      >
        全部题单 →
      </NuxtLink>
    </div>
    <AsyncContent
      :status="error ? 'error' : trainings.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      empty-text="暂无公开题单"
      @retry="refresh()"
    >
      <ul class="divide-y divide-border-subtle">
        <li v-for="training in trainings" :key="training.id">
          <NuxtLink
            :to="workspacePath(domainSlug, `trainings/${training.id}`)"
            class="block px-3 py-2 text-[13px] no-underline hover:bg-bg-sunken/60"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium text-text">{{ training.title }}</span>
              <span
                v-if="training.source_domain_slug && training.source_domain_slug !== domainSlug"
                class="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[10px] text-text-muted"
              >
                {{ training.source_domain_slug }}
              </span>
            </div>
            <p v-if="training.description" class="mt-0.5 truncate text-xs text-text-muted">
              {{ training.description }}
            </p>
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
