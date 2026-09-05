<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast'

useHead({ title: '我的题单 - Neuro OJ' })

definePageMeta({ middleware: 'auth' })

const { deleteTraining } = useTrainings()
const { dialog } = useDialog()
const { toast } = useToast()
const { data, pending, error, refresh } = await useFetch<{ data: Training[]; total: number }>(
  '/api/v1/trainings/mine',
  { query: { page: 1, per_page: 100 } },
)
const showCreate = ref(false)
const showEdit = ref(false)
const editingTraining = ref<Training | null>(null)

function onEdit(training: Training) {
  editingTraining.value = training
  showEdit.value = true
}

async function onDelete(id: string) {
  const ok = await dialog.confirm(
    '确定删除该题单？删除后题目关联也会一并清除，且无法恢复。',
    { title: '删除题单', confirmText: '删除', danger: true },
  )
  if (!ok) return
  try {
    await deleteTraining(id)
  } catch {
    // useApi 已弹错误；删除失败不刷新
    return
  }
  // 刷新优先：删除成功一定刷新列表，不依赖 toast（toast 异常不阻断刷新）
  try {
    toast.success('题单已删除')
  } catch {
    // toast 失败不影响删除与刷新
  }
  await refresh()
}
</script>

<template>
  <div class="min-h-full bg-bg-page py-10">
    <div class="mx-auto max-w-[960px] space-y-7 px-4 sm:px-7">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">我的题单</h1>
        <UButton icon="i-lucide-plus" @click="showCreate = true">新建题单</UButton>
      </div>

      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : data?.data.length ? 'data' : 'empty'"
        error="加载失败"
        empty-text="你还没有创建题单"
        @retry="refresh"
      >
        <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <div
            v-for="training in data?.data"
            :key="training.id"
            class="relative"
          >
            <TrainingCard :training="training" />
            <div class="absolute right-2 top-2 flex gap-1">
              <UButton
                icon="i-lucide-pencil"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="onEdit(training)"
              />
              <UButton
                icon="i-lucide-trash"
                size="xs"
                color="error"
                variant="ghost"
                @click="onDelete(training.id)"
              />
            </div>
          </div>
        </div>
      </AsyncContent>

      <TrainingFormModal v-model="showCreate" @saved="refresh" />
      <TrainingFormModal v-model="showEdit" :training="editingTraining" @saved="refresh" />
    </div>
  </div>
</template>
