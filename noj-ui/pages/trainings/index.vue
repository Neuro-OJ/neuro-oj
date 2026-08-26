<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'
import { useToast } from '~/composables/useToast'

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
  await refresh()
  try {
    toast.success('题单已创建')
  } catch {
    // toast 失败不影响刷新
  }
}
</script>

<template>
  <div class="min-h-full bg-bg-page py-10">
    <div class="mx-auto max-w-[960px] space-y-7 px-4 sm:px-7">
      <section class="rounded-2xl bg-bg-dark px-8 py-9 text-white shadow-card">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h1 class="text-3xl font-bold">题单</h1>
            <p class="mt-3 text-sm leading-6 text-slate-300">按学习路径刷题，整理自己的题目集合。</p>
          </div>
          <UButton
            v-if="isLoggedIn"
            icon="i-lucide-plus"
            color="primary"
            @click="showCreate = true"
          >新建题单</UButton>
        </div>
      </section>

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
