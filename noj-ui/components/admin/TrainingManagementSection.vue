<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Training, TrainingVisibility } from '~/composables/useTrainings'

const { adminUpdateTraining, adminDeleteTraining } = useTrainings()
const { data, pending, error, refresh } = await useFetch<{ data: Training[]; total: number }>(
  '/api/v1/admin/trainings',
  { query: { page: 1, per_page: 100 } },
)

const columns: TableColumn<Training>[] = [
  { accessorKey: 'title', header: '标题' },
  { accessorKey: 'visibility', header: '可见性' },
  { accessorKey: 'is_pinned', header: '置顶' },
  { accessorKey: 'problem_count', header: '题目数' },
  { accessorKey: 'actions', header: '操作' },
]

async function setVisibility(training: Training, visibility: TrainingVisibility) {
  await adminUpdateTraining(training.id, { visibility })
  await refresh()
}

async function togglePinned(training: Training) {
  await adminUpdateTraining(training.id, { is_pinned: !training.is_pinned })
  await refresh()
}

async function remove(id: string) {
  if (!confirm('确定删除该题单？')) return
  await adminDeleteTraining(id)
  await refresh()
}
</script>

<template>
  <AsyncContent
    :status="pending ? 'loading' : error ? 'error' : 'data'"
    error="题单加载失败"
    @retry="refresh"
  >
    <UTable
      :columns="columns"
      :data="data?.data ?? []"
      :loading="pending"
      :empty="'暂无题单'"
    >
      <template #visibility-cell="{ row }">
        <USelect
          :model-value="row.original.visibility"
          :items="[
            { label: '私有', value: 'private' },
            { label: '链接可见', value: 'unlisted' },
            { label: '公开', value: 'public' },
          ]"
          class="min-w-[120px]"
          @update:model-value="setVisibility(row.original, $event as TrainingVisibility)"
        />
      </template>
      <template #is_pinned-cell="{ row }">
        <UCheckbox
          :model-value="row.original.is_pinned"
          @update:model-value="togglePinned(row.original)"
        />
      </template>
      <template #actions-cell="{ row }">
        <UButton
          icon="i-lucide-trash"
          size="xs"
          color="error"
          variant="ghost"
          @click="remove(row.original.id)"
        />
      </template>
    </UTable>
  </AsyncContent>
</template>
