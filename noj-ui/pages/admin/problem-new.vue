<script setup lang="ts">
definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const router = useRouter()

useRequireLogin()

function onSaved() {
  router.replace("/admin/problems")
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

    <CodingProblemEditor mode="create" initial-type="P" @saved="onSaved" />
  </div>
</template>
