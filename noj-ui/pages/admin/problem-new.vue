<script setup lang="ts">
import { ArrowLeft } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  ssr: false,
})

const router = useRouter()

function onSaved() {
  router.replace("/admin/problems")
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline transition-colors hover:text-primary">
      <ArrowLeft :size="16" />
      返回题目列表
    </NuxtLink>

    <h1 class="text-[22px] font-bold text-text m-0">创建题目</h1>

    <ProblemEditor mode="create" initial-type="P" @saved="onSaved" />
  </div>
</template>
