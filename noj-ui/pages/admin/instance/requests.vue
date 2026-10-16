<script setup lang="ts">
import type { DomainCreationRequest } from '~/utils/instance-governance';
import { WORKSPACE_PRESETS } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });

const route = useRoute();
const router = useRouter();
const api = useInstanceAdmin();
const { user } = useAuth();
const { dialog } = useDialog();

const requestPage = computed({
  get: () => Number(route.query.page || 1),
  set: (val) => router.replace({ query: { ...route.query, page: val === 1 ? undefined : String(val) } }),
});

const requestStatus = computed({
  get: () => (route.query.status as 'all' | DomainCreationRequest['status']) || 'pending',
  set: (val) => router.replace({ query: { ...route.query, status: val === 'pending' ? undefined : val, page: undefined } }),
});

const busy = ref('');
const failure = ref('');

const key = computed(() => `instance-requests:${user.value?.id}:${requestPage.value}:${requestStatus.value}`);
const { data: requests, status: loadStatus, error, refresh } = await useAsyncData(key, () =>
  api.requests({
    page: requestPage.value,
    status: requestStatus.value === 'all' ? undefined : requestStatus.value,
  })
);

const presetLabel = (preset: string) => WORKSPACE_PRESETS.find((item) => item.value === preset)?.label ?? preset;

async function review(row: DomainCreationRequest, approved: boolean) {
  if (busy.value) return;
  const target = { id: row.id, name: row.name, slug: row.slug, applicant: row.applicant_username };
  const actor = user.value?.id;
  const confirmed = await dialog.confirm(
    `${approved ? '批准' : '拒绝'}「${target.name}」(${target.slug})的创建申请？${
      approved ? `批准后由申请人 ${target.applicant} 成为负责人。` : ''
    }`,
    { title: '审核创建申请', danger: !approved },
  );
  if (!confirmed) return;
  if (user.value?.id !== actor) return;
  busy.value = target.id;
  failure.value = '';
  try {
    await api.review(target.id, approved);
    if (user.value?.id === actor) {
      await refresh();
    }
  } catch (err) {
    if (user.value?.id === actor) failure.value = extractApiError(err).message;
  } finally {
    busy.value = '';
  }
}

useSeoMeta({ title: '空间创建申请 - 实例设置' });
</script>

<template>
  <div class="space-y-6">
    <AdminPageHeader title="实例与域治理" description="管理实例全局政策、可选模块与各空间资源上限。" icon="i-lucide-building-2">
      <template #actions>
        <UButton variant="outline" @click="refresh()">重新读取申请</UButton>
      </template>
    </AdminPageHeader>

    <InstanceNav />

    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-text">工作空间创建申请</h2>
          <p class="text-xs text-text-secondary mt-0.5">
            审核普通用户提交的工作空间开通申请。
          </p>
        </div>

        <div class="flex items-center gap-2">
          <USelect
            v-model="requestStatus"
            :items="[
              { label: '待审核', value: 'pending' },
              { label: '已批准', value: 'approved' },
              { label: '已拒绝', value: 'rejected' },
              { label: '全部申请', value: 'all' }
            ]"
            class="w-36"
            aria-label="创建申请状态"
          />
        </div>
      </div>

      <UAlert v-if="failure" color="error" :title="failure" class="mb-4" />

      <AsyncContent
        :status="error ? 'error' : loadStatus === 'pending' ? 'loading' : requests?.data.length ? 'data' : 'empty'"
        :error="error ? extractApiError(error).message : undefined"
        empty-text="暂无符合条件的创建申请"
        @retry="refresh()"
      >
        <div class="space-y-3">
          <UCard
            v-for="row in requests?.data"
            :key="row.id"
            class="rounded border border-border bg-bg-panel p-4"
          >
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
              <h3 class="font-medium text-text">
                {{ row.name }}
                <span class="ml-2 font-mono text-xs text-text-muted">/d/{{ row.slug }}</span>
              </h3>
              <UBadge
                :color="row.status === 'pending' ? 'primary' : row.status === 'approved' ? 'success' : 'neutral'"
                variant="subtle"
              >
                {{ row.status === 'pending' ? '待审核' : row.status === 'approved' ? '已批准' : '已拒绝' }}
              </UBadge>
            </div>

            <p class="mt-2 text-xs text-text-muted">
              申请人：<span class="font-medium text-text-secondary">{{ row.applicant_deleted ? '已注销用户' : row.applicant_username }}</span> ·
              类型：{{ presetLabel(row.preset) }} ·
              提交时间：{{ new Date(row.created_at).toLocaleString() }}
            </p>

            <div class="mt-2.5 rounded bg-bg-sunken p-3 text-sm text-text-secondary whitespace-pre-wrap">
              {{ row.reason || '（未填写申请理由）' }}
            </div>

            <div v-if="row.status === 'pending'" class="mt-3 flex items-center gap-2">
              <UButton
                :disabled="!!busy || row.applicant_deleted"
                :loading="busy === row.id"
                color="primary"
                size="sm"
                @click="review(row, true)"
              >
                批准创建
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                :disabled="!!busy"
                @click="review(row, false)"
              >
                拒绝申请
              </UButton>
            </div>
            <p v-else class="mt-2 text-xs text-text-muted">
              处理结果：{{ row.status === 'approved' ? '已批准' : '已拒绝' }}
              <span v-if="row.reviewed_at"> · 处理时间：{{ new Date(row.reviewed_at).toLocaleString() }}</span>
            </p>
          </UCard>
        </div>

        <!-- 分页与统计 -->
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm text-text-muted">
          <p class="tabular-nums">
            共 {{ requests?.pagination.total ?? 0 }} 份申请
            <span v-if="requests?.pagination.total_pages">
              · 第 {{ requestPage }} / {{ requests?.pagination.total_pages }} 页
            </span>
          </p>

          <div v-if="requests && requests.pagination.total_pages > 1" class="flex items-center gap-2">
            <UButton
              variant="outline"
              color="neutral"
              size="sm"
              :disabled="requestPage <= 1"
              @click="requestPage--"
            >
              上一页
            </UButton>
            <UButton
              variant="outline"
              color="neutral"
              size="sm"
              :disabled="requestPage >= requests.pagination.total_pages"
              @click="requestPage++"
            >
              下一页
            </UButton>
          </div>
        </div>
      </AsyncContent>
    </div>
  </div>
</template>
