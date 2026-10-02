<script setup lang="ts">
definePageMeta({ layout: "admin", middleware: "admin", ssr: false })
useHead({ title: "创建传统 OI 题 - Neuro OJ" })
const router = useRouter()
function onSaved() {
  router.replace("/admin/problems")
}
</script>

<template>
  <div class="flex max-w-[980px] flex-col gap-4">
    <AdminPageHeader title="创建传统 OI 题" description="配置 C/C++ 非交互题的资源、比较器和子任务" />
    <OiProblemEditor initial-type="P" @saved="onSaved" />
  </div>
</template>
