<script setup lang="ts">
import { DOMAIN_STATUS_LABELS } from '~/utils/instance-governance';
import type { DomainCreationRequest, InstanceDomain } from '~/utils/instance-governance';
import { WORKSPACE_PRESETS, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const api = useInstanceAdmin(), workspaces = useWorkspaceApi(), { user } = useAuth(), { dialog } = useDialog();
const page = ref(1), statusFilter = ref<'all' | InstanceDomain['status']>('all');
const search = ref(''),
  keyword = ref(''),
  requestPage = ref(1),
  requestStatus = ref<'all' | DomainCreationRequest['status']>('pending');
const busy = ref(''), failure = ref('');
const domains = await useAsyncData(
  () => `instance-governance:${user.value?.id}:domains:${page.value}:${statusFilter.value}:${keyword.value}`,
  () =>
    api.domains({
      page: page.value,
      status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      keyword: keyword.value || undefined,
    }),
);
const requests = await useAsyncData(
  () => `instance-governance:${user.value?.id}:requests:${requestPage.value}:${requestStatus.value}`,
  () =>
    api.requests({ page: requestPage.value, status: requestStatus.value === 'all' ? undefined : requestStatus.value }),
);
watch([statusFilter, keyword], () => {
  page.value = 1;
});
watch(requestStatus, () => {
  requestPage.value = 1;
});
const presetLabel = (preset: string) => WORKSPACE_PRESETS.find((item) => item.value === preset)?.label ?? preset;
async function setStatus(row: InstanceDomain, status: InstanceDomain['status']) {
  if (busy.value) return;
  const target = { slug: row.slug, name: row.name, revision: row.revision }, actor = user.value?.id;
  const label = DOMAIN_STATUS_LABELS[status];
  if (
    !await dialog.confirm(
      `将空间「${target.name}」(${target.slug})设为${label}？${
        status === 'suspended'
          ? '普通用户将停止访问。'
          : status === 'archived'
          ? '保留授权历史读取，停止新业务写入。'
          : '恢复按空间政策访问。'
      }`,
      { title: `${label}空间` },
    )
  ) return;
  if (user.value?.id !== actor) return;
  busy.value = target.slug;
  failure.value = '';
  try {
    await workspaces.status(target.slug, status, target.revision);
    if (user.value?.id === actor) await domains.refresh();
  } catch (error) {
    if (user.value?.id === actor) failure.value = extractApiError(error).message;
  } finally {
    busy.value = '';
  }
}
async function review(row: DomainCreationRequest, approved: boolean) {
  if (busy.value) return;
  const target = { id: row.id, name: row.name, slug: row.slug, applicant: row.applicant_username },
    actor = user.value?.id;
  if (
    !await dialog.confirm(
      `${approved ? '批准' : '拒绝'}「${target.name}」(${target.slug})的创建申请？${
        approved ? `批准后由申请人 ${target.applicant} 成为负责人。` : ''
      }`,
      { title: '审核创建申请' },
    )
  ) return;
  if (user.value?.id !== actor) return;
  busy.value = target.id;
  failure.value = '';
  try {
    await api.review(target.id, approved);
    if (user.value?.id === actor) {
      await requests.refresh();
      if (approved) await domains.refresh();
    }
  } catch (error) {
    if (user.value?.id === actor) failure.value = extractApiError(error).message;
  } finally {
    busy.value = '';
  }
}
</script>
<template>
  <div class="space-y-6">
    <UAlert v-if="failure" color="error" :title="failure"
      description="操作没有自动重试，请重新读取目标状态后决定下一步。" />
    <section class="space-y-4">
      <h2 class="font-semibold">全部工作空间</h2>
      <p
        class="text-sm text-text-secondary">包含不公开发现的私有空间与暂停空间。进入管理页面时仍会检查目标域权限并记录治理操作。</p>
      <form class="flex flex-wrap gap-3" @submit.prevent="keyword = search.trim()">
        <UInput v-model="search" placeholder="名称或网址标识" aria-label="搜索治理空间" />
        <USelect v-model="statusFilter"
          :items="[{ label: '全部状态', value: 'all' }, ...Object.entries(DOMAIN_STATUS_LABELS).map(([value, label]) => ({value, label}))]"
          aria-label="治理空间状态" />
        <UButton type="submit" variant="outline">搜索空间</UButton>
        <UButton type="button" variant="ghost" @click="domains.refresh()">重新读取空间</UButton>
      </form>
      <AsyncContent
        :status="domains.error.value ? 'error' : domains.status.value === 'pending' ? 'loading' : domains.data.value?.data.length ? 'data' : 'empty'"
        :error="domains.error.value ? extractApiError(domains.error.value).message : undefined"
        empty-text="没有符合条件的空间" @retry="domains.refresh()">
        <UCard v-for="row in domains.data.value?.data" :key="row.id">
          <div class="flex flex-wrap justify-between gap-3">
            <div>
              <h3
                class="font-medium">{{ row.name }} <span class="ml-2 font-mono text-xs text-text-muted">{{ row.slug }}</span></h3>
              <p
                class="mt-2 text-sm text-text-secondary">{{ DOMAIN_STATUS_LABELS[row.status] }} · {{ presetLabel(row.preset) }} · 负责人 {{ row.owner_username }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton :to="workspacePath(row.slug, 'settings')" variant="outline">管理设置与额度</UButton>
              <UButton :to="workspacePath(row.slug, 'members')" variant="outline">管理成员</UButton>
              <UButton :to="workspacePath(row.slug, 'llm')" variant="outline">管理 Provider</UButton>
              <UButton v-if="row.status !== 'active'" variant="outline" :disabled="!!busy" :loading="busy === row.slug"
                @click="setStatus(row, 'active')">恢复使用</UButton>
              <UButton v-if="row.slug !== 'main' && row.status === 'active'" variant="outline" :disabled="!!busy"
                @click="setStatus(row, 'archived')">归档</UButton>
              <UButton v-if="row.slug !== 'main' && row.status !== 'suspended'" color="error" variant="outline"
                :disabled="!!busy" @click="setStatus(row, 'suspended')">暂停访问</UButton>
            </div>
          </div>
        </UCard>
        <p class="text-xs text-text-muted tabular-nums">共 {{ domains.data.value?.pagination.total ?? 0 }} 个空间</p>
        <UPagination v-if="domains.data.value && domains.data.value.pagination.total_pages > 1" v-model:page="page"
          :total="domains.data.value.pagination.total" :items-per-page="20" />
      </AsyncContent>
    </section>
    <section class="space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="mr-auto font-semibold">工作空间创建申请</h2>
        <USelect v-model="requestStatus"
          :items="[{ label: '待审核', value: 'pending' }, { label: '已批准', value: 'approved' }, { label: '已拒绝', value: 'rejected' }, { label: '全部申请', value: 'all' }]"
          aria-label="创建申请状态" />
        <UButton variant="ghost" @click="requests.refresh()">重新读取申请</UButton>
      </div>
      <AsyncContent
        :status="requests.error.value ? 'error' : requests.status.value === 'pending' ? 'loading' : requests.data.value?.data.length ? 'data' : 'empty'"
        :error="requests.error.value ? extractApiError(requests.error.value).message : undefined"
        empty-text="暂无符合条件的创建申请" @retry="requests.refresh()">
        <UCard v-for="row in requests.data.value?.data" :key="row.id">
          <h3
            class="font-medium">{{ row.name }} <span class="ml-2 font-mono text-xs text-text-muted">{{ row.slug }}</span></h3>
          <p
            class="mt-2 text-sm text-text-secondary">申请人 {{ row.applicant_deleted ? '已注销用户' : row.applicant_username }} · {{ presetLabel(row.preset) }} · {{ new Date(row.created_at).toLocaleString() }}</p>
          <p class="mt-3 whitespace-pre-wrap text-sm">{{ row.reason }}</p>
          <div v-if="row.status === 'pending'" class="mt-3 flex gap-2">
            <UButton :disabled="!!busy || row.applicant_deleted" :loading="busy === row.id"
              @click="review(row, true)">批准创建</UButton>
            <UButton color="neutral" variant="outline" :disabled="!!busy" @click="review(row, false)">拒绝申请</UButton>
          </div>
          <p v-else
            class="mt-3 text-xs text-text-muted">{{ row.status === 'approved' ? '已批准' : '已拒绝' }} · {{ row.reviewed_at ? new Date(row.reviewed_at).toLocaleString() : '' }}</p>
        </UCard>
        <p class="text-xs text-text-muted tabular-nums">共 {{ requests.data.value?.pagination.total ?? 0 }} 份申请</p>
        <UPagination v-if="requests.data.value && requests.data.value.pagination.total_pages > 1"
          v-model:page="requestPage" :total="requests.data.value.pagination.total" :items-per-page="20" />
      </AsyncContent>
    </section>
  </div>
</template>
