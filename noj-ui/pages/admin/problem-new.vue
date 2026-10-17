<script setup lang="ts">
definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const router = useRouter()
const route = useRoute()

useRequireLogin()

// 建题后直接进入该题编辑页上传支持包、核对并发布（而不是退回列表再去找）。
function onSaved(problemId: string) {
  router.replace(`/admin/problem-edit/${problemId}`)
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <AdminPageHeader title="创建题目" description="创建新的编程题">
      <template #breadcrumb>
        <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline transition-colors hover:text-primary">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          返回题目列表
        </NuxtLink>
      </template>
    </AdminPageHeader>



    <ProblemEditor mode="create" :initial-judge-type="route.query.type === 'oi' ? 'oi' : 'dual'" initial-type="P" @saved="onSaved" />
  </div>
</template>
