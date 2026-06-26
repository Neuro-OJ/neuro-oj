<script setup lang="ts">
import { ArrowLeft } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string

function onSaved() {
  router.replace("/admin/problems")
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary">
      <ArrowLeft :size="16" />
      返回题目列表
    </NuxtLink>

    <h1 class="text-[22px] font-bold text-text m-0">编辑题目</h1>

    <ProblemEditor mode="edit" :problem-id="problemId" @saved="onSaved" />
  </div>
</template>
