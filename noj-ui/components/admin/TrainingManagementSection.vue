<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'
import type { AdminColumn } from "~/components/admin/AdminTable.vue"

const { adminUpdateTraining, adminDeleteTraining } = useTrainings()
const { data, pending, error, refresh } = await useFetch<{ data: Training[]; total: number }>(
  '/api/v1/admin/catalog/trainings',
  { query: { page: 1, per_page: 100 } },
)

const columns: AdminColumn[] = [
  { key: 'title', label: '标题' },
  { key: 'state', label: '发布状态' },
  { key: 'is_pinned', label: '置顶' },
  { key: 'problem_count', label: '题目数' },
  { key: 'actions', label: '操作' },
]

async function setState(training: Training, state: Training['state']) {
  await adminUpdateTraining(training.id, { state }, {
    headers: { "If-Match": `"${training.updated_at}"` },
  })
  await refresh()
}

async function togglePinned(training: Training) {
  await adminUpdateTraining(training.id, { is_pinned: !training.is_pinned }, {
    headers: { "If-Match": `"${training.updated_at}"` },
  })
  await refresh()
}

async function remove(training: Training) {
  if (!confirm('确定删除该题单？')) return
  await adminDeleteTraining(training.id, {
    headers: { "If-Match": `"${training.updated_at}"` },
  })
  await refresh()
}
</script>

<template>
  <AsyncContent
    :status="pending ? 'loading' : error ? 'error' : 'data'"
    error="题单加载失败"
    @retry="refresh"
  >
    <AdminTable
      :columns="columns"
      :items="(data?.data ?? []) as unknown as Record<string, unknown>[]"
      :loading="pending"
      :error="error ? '题单加载失败' : undefined"
      :total-pages="1"
      :current-page="1"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'state'">
          <USelect
            :model-value="(row as unknown as Training).state"
            :items="[
              { label: '草稿', value: 'draft' },
              
              { label: '已发布', value: 'published' },
            ]"
            class="min-w-[120px]"
            @update:model-value="setState(row as unknown as Training, $event as Training['state'])"
          />
        </template>
        <template v-else-if="column.key === 'is_pinned'">
          <UCheckbox
            :model-value="(row as unknown as Training).is_pinned"
            @update:model-value="togglePinned(row as unknown as Training)"
          />
        </template>
      </template>
      <template #actions="{ row }">
        <UButton
          icon="i-lucide-trash"
          size="xs"
          color="error"
          variant="ghost"
          @click="remove(row as unknown as Training)"
        />
      </template>
    </AdminTable>
  </AsyncContent>
</template>
