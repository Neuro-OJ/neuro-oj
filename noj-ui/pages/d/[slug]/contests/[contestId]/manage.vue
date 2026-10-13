<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute();
const { slug } = useWorkspace();
const { user } = useAuth();
const scope = useWorkspaceActionScope();
const api = useDomainContests();
const id = computed(() => String(route.params.contestId));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-manage', id.value));
const { data, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));
const { data: settlement, error: settlementError, refresh: refreshSettlement } = await useAsyncData(
  computed(() => `${key.value}:settlement`),
  () => data.value?.data.can_manage ? api.settlement(slug.value!, id.value) : Promise.resolve(null),
);
const { data: snapshots, refresh: refreshSnapshots } = await useAsyncData(
  computed(() => `${key.value}:snapshots`),
  () => data.value?.data.can_manage ? api.snapshots(slug.value!, id.value) : Promise.resolve(null),
);
const note = ref('');
const allowFailed = ref(false);
const publishing = ref(false);
const failure = ref('');
async function publish() {
  const operation = scope();
  publishing.value = true;
  failure.value = '';
  try {
    await api.publish(operation.slug, id.value, note.value, allowFailed.value);
    if (operation.isCurrent()) await Promise.all([refreshSettlement(), refreshSnapshots()]);
  } catch (e) {
    if (operation.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    if (operation.isCurrent()) publishing.value = false;
  }
}
useSeoMeta({ title: '管理比赛' });
</script>
<template>
  <div class="space-y-5">
    <UAlert v-if="error" color="error" :title="extractApiError(error).message">
      <template #actions>
        <UButton @click="refresh()">重试</UButton>
      </template>
    </UAlert>
    <template v-if="data?.data.can_manage">
      <h2 class="text-xl font-semibold">{{ data.data.title }} · 管理</h2>
      <DomainContestForm :slug="slug!" :existing="data.data" />
      <ClientOnly>
        <DomainRejudgeAction :slug="slug!" :scope="{ type: 'contest', contest_id: data.data.id }"
          label="重测本域整场比赛" :eligible="true" />
      </ClientOnly>
      <UCard v-if="data.data.status === 'ended'">
        <h3 class="mb-3 font-semibold">发布正式成绩</h3>
        <UAlert v-if="settlementError" color="error" :title="extractApiError(settlementError).message" />
        <p v-if="settlement"
          class="mb-3 text-sm text-text-secondary tabular-nums">待处理 {{ settlement.data.pending_count }} 项，平台失败 {{ settlement.data.failed_count }} 项。</p>
        <UTextarea v-model="note" placeholder="发布说明；重新发布或带平台失败发布时必须填写" class="mb-3 w-full"
          aria-label="正式成绩发布说明" />
        <UCheckbox v-model="allowFailed" label="明确允许带平台失败发布，并记录说明" class="mb-3" />
        <UAlert v-if="failure" color="error" :title="failure" class="mb-3" />
        <UButton :loading="publishing" :disabled="allowFailed && !note.trim()"
          @click="publish">发布新版本正式成绩</UButton>
        <p class="mt-3 text-xs text-text-muted">正式快照保留发布时成绩，后续重测不会自动改写；再次发布将产生新版本。</p>
        <ul class="mt-4 space-y-2 text-sm">
          <li v-for="snapshot in snapshots?.data"
            :key="snapshot.id">V{{ snapshot.version }} · {{ new Date(snapshot.created_at).toLocaleString() }} · {{ snapshot.note || '首次发布' }}</li>
        </ul>
      </UCard>
    </template>
    <UAlert v-else-if="data" color="warning" title="没有这场比赛的组织权限" />
  </div>
</template>
