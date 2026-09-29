<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'
import { useToast } from '~/composables/useToast'

definePageMeta({ breadcrumbWidth: '960px' })

useHead({ title: '题单 - Neuro OJ' })

const currentPage = ref(1)
const perPage = 12

const { isLoggedIn } = useAuth()
const { toast } = useToast()
const showCreate = ref(false)

const { data, pending, error, refresh } = await useFetch<{ data: Training[]; total: number }>(
  '/api/v1/trainings',
  {
    query: computed(() => ({ page: currentPage.value, per_page: perPage })),
  },
)
const totalPages = computed(() => Math.ceil((data.value?.total ?? 0) / perPage))

async function onCreate() {
  try {
    await refresh()
    toast.success('题单已创建')
  } catch {
    toast.error('题单已创建，但列表刷新失败')
  }
}
</script>

<template>
  <div class="min-h-full bg-bg-page py-10">
    <div class="mx-auto max-w-[960px] space-y-6 px-4 sm:px-7">
      <!-- 页面头部（开放式轻量页头，对齐题库与榜单） -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex size-10 items-center justify-center rounded-lg bg-primary-bg text-primary border border-primary/20 shadow-xs">
            <UIcon name="i-lucide-list-todo" class="size-5" />
          </div>
          <div>
            <h1 class="text-2xl font-bold text-text leading-tight">题单大厅</h1>
            <p class="text-xs text-text-muted mt-0.5">按学习路径精选题单，系统化训练解题与工程技能</p>
          </div>
        </div>
        <UButton
          v-if="isLoggedIn"
          icon="i-lucide-plus"
          color="primary"
          @click="showCreate = true"
        >新建题单</UButton>
      </div>

      <AsyncContent
        :status="pending ? 'loading' : error ? 'error' : data?.data.length ? 'data' : 'empty'"
        error="题单列表加载失败"
        empty-text="暂无公开题单"
        @retry="refresh"
      >
        <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <TrainingCard
            v-for="training in data?.data"
            :key="training.id"
            :training="training"
          />
        </div>
      </AsyncContent>

      <PaginationNav
        :current-page="currentPage"
        :total-pages="totalPages"
        @page-change="currentPage = $event"
      />

      <TrainingFormModal v-model="showCreate" @saved="onCreate" />
    </div>
  </div>
</template>