<script setup lang="ts">
definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string
const { data } = await useFetch<{ data: { judge_type?: 'dual' | 'oi'; is_objective?: boolean } }>(
  `/api/v1/problems/${problemId}`,
  { server: false },
)
const isOi = computed(() => data.value?.data?.judge_type === 'oi')

function onSaved() {
  router.replace("/admin/problems")
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <AdminPageHeader title="编辑题目" description="编辑现有题目">
      <template #breadcrumb>
        <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          返回题目列表
        </NuxtLink>
      </template>
    </AdminPageHeader>

    <OiProblemEditor v-if="data && isOi" mode="edit" :problem-id="problemId" @saved="onSaved" />
    <CodingProblemEditor v-else-if="data" mode="edit" :problem-id="problemId" @saved="onSaved" />
  </div>
</template>
