<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute();
const { slug } = useWorkspace();
const { user, isLoggedIn } = useAuth();
const api = useDomainContests();
const scope = useWorkspaceActionScope();
const id = computed(() => String(route.params.contestId));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest', id.value));
const { data, error, status, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));
const password = ref('');
const registering = ref(false);
const failure = ref('');
const { data: problems, error: problemsError, refresh: refreshProblems } = await useAsyncData(
  computed(() => `${key.value}:problems:${data.value?.data.is_registered}:${data.value?.data.status}`),
  () =>
    data.value?.data.can_manage || data.value?.data.is_registered && data.value.data.status !== 'pending'
      ? api.problems(slug.value!, id.value)
      : Promise.resolve(null),
);
async function register() {
  const operation = scope();
  registering.value = true;
  failure.value = '';
  try {
    await api.register(operation.slug, id.value, password.value);
    if (operation.isCurrent()) await refresh();
  } catch (e) {
    if (operation.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    if (operation.isCurrent()) registering.value = false;
  }
}
useSeoMeta({ title: () => data.value?.data.title ?? '比赛' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-xl font-semibold">{{ data.data.title }}</h2>
        <div class="flex gap-2">
          <UButton :to="`/d/${slug}/contests/${id}/ranking`" variant="outline">成绩榜</UButton>
          <UButton v-if="data.data.can_manage" :to="`/d/${slug}/contests/${id}/manage`"
            variant="outline">管理比赛</UButton>
        </div>
      </div>
      <UCard>
        <UBadge
          variant="subtle">{{ DOMAIN_CONTEST_TYPES.find((type) => type.value === data?.data.type)?.label }}</UBadge>
        <p
          class="my-3 text-sm text-text-secondary">{{ DOMAIN_CONTEST_TYPES.find((type) => type.value === data?.data.type)?.description }}</p>
        <MarkdownRenderer :content="data.data.description" />
        <p
          class="mt-4 text-sm tabular-nums">{{ new Date(data.data.start_time).toLocaleString() }} — {{ new Date(data.data.end_time).toLocaleString() }}</p>
      </UCard>
      <UCard v-if="!data.data.is_registered && data.data.status !== 'ended' && isLoggedIn">
        <UInput v-if="data.data.has_password" v-model="password" type="password" placeholder="报名密码"
          aria-label="报名密码" class="mr-3" />
        <UButton :loading="registering" @click="register">报名参赛</UButton>
        <UAlert v-if="failure" color="error" :title="failure" class="mt-3" />
      </UCard>
      <UAlert v-if="data.data.type === 'oi' && data.data.status === 'running'" color="info"
        title="赛时不公开成绩与判定。已受理提交按每题最后一次提交计算。" />
      <UAlert v-if="problemsError" color="error" :title="extractApiError(problemsError).message">
        <template #actions>
          <UButton @click="refreshProblems()">重试</UButton>
        </template>
      </UAlert>
      <UCard v-for="problem in problems?.data" :key="problem.problem_id">
        <NuxtLink :to="`/d/${slug}/contests/${id}/problems/${encodeURIComponent(problem.label)}`"
          class="font-semibold text-primary">{{ problem.label }} · {{ problem.title }}</NuxtLink>
        <p class="mt-2 text-xs text-text-muted">{{ problem.display_id }} · V{{ problem.version }}</p>
      </UCard>
    </div>
  </AsyncContent>
</template>
