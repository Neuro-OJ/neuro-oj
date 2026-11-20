<script setup lang="ts">
import type { BundleImportResult } from "~/utils/bundleImport"

definePageMeta({

})

useHead({ title: '从题目包导入 - Neuro OJ' })

const router = useRouter()

function onImported(result: BundleImportResult) {
  router.replace(`/d/main/editor/${result.number}`)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <h1 class="text-2xl font-bold text-text mb-1">从题目包导入</h1>
    <p class="mb-5 text-sm text-text-secondary">
      上传完整题目包即可建题，题面与评测配置都取自包内，导入后进入编辑页核对并发布。
    </p>

    <BundleImportPanel domain-slug="main" @imported="onImported" />
  </div>
</template>
