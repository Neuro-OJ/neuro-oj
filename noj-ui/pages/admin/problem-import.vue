<script setup lang="ts">
import type { BundleImportResult } from "~/utils/bundleImport"

definePageMeta({
  layout: "admin",
  middleware: "admin",

})

const router = useRouter()

useRequireLogin()

function onImported(result: BundleImportResult) {
  router.replace(`/d/main/editor/${result.number}`)
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-[800px]">
    <AdminPageHeader title="导入题目包" description="上传完整题目包 zip 直接建题，导入后进入编辑页核对并发布">
      <template #breadcrumb>
        <NuxtLink to="/admin/problems" class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline transition-colors hover:text-primary">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          返回题目列表
        </NuxtLink>
      </template>
    </AdminPageHeader>

    <BundleImportPanel domain-slug="main" @imported="onImported" />
  </div>
</template>
