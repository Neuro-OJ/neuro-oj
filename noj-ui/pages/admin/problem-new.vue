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
  <div class="page">
    <NuxtLink to="/admin/problems" class="back-link">
      <ArrowLeft :size="16" />
      返回题目列表
    </NuxtLink>

    <h1 class="title">创建题目</h1>

    <ProblemEditor mode="create" initial-type="P" @saved="onSaved" />
  </div>
</template>

<style scoped>
.page {
  max-width: 800px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--c-text-secondary);
  text-decoration: none;
  transition: color 0.15s;
}

.back-link:hover {
  color: var(--c-primary);
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
  margin: 0;
}
</style>
