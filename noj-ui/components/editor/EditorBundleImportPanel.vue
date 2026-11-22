<script setup lang="ts">
/**
 * 从统一题目包 zip 直接建题（`POST /api/v1/problems/import-bundle`，不带 problem_id）。
 *
 * 题面、评测配置、模板、LLM、题型与提交模式全部来自包内 problem.json / statement.md，
 * 不需要先手填一遍会被覆盖的表单。默认导入为草稿，可勾选「导入后立即发布」。
 * 导入成功后由页面决定跳转（用户侧 / 管理后台的编辑页路径不同）。
 */
import { extractApiError } from "~/utils/apiError"
import { useToast } from "~/composables/useToast"
import {
  type BundleImportResult,
  bundleImportErrorMessage,
  bundleImportSuccessMessage,
} from "~/utils/bundleImport"

const emit = defineEmits<{ imported: [result: BundleImportResult] }>()
const props = defineProps<{ domainSlug: string }>()

const { api } = useApi()
const { toast } = useToast()

const publish = ref(false)
const importing = ref(false)
const importError = ref("")

async function handleFile(file: File) {
  const slug = props.domainSlug
  importing.value = true
  importError.value = ""
  try {
    const formData = new FormData()
    formData.append("file", file)
    const problemPath = `/api/v1/domains/${encodeURIComponent(slug)}/problems`
    const res = await api.post<{ data: BundleImportResult }>(
      `${problemPath}/import-bundle`,
      formData,
    )
    if (publish.value) {
      res.data.published = await api.post<NonNullable<BundleImportResult['published']>>(
        `${problemPath}/${res.data.number}/publish`,
        { change_note: '题目包导入' },
        { headers: { 'If-Match': String(res.data.draft_revision) } },
      )
    }
    if (slug !== props.domainSlug) return
    toast.success(bundleImportSuccessMessage(res.data))
    emit("imported", res.data)
  } catch (err: unknown) {
    importError.value = bundleImportErrorMessage(extractApiError(err))
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 bg-white border border-border rounded px-6 py-5">
    <div>
      <h2 class="text-sm font-semibold text-text">上传题目包</h2>
      <p class="mt-1 text-xs text-text-secondary leading-relaxed">
        题目包是一个 zip：根目录包含 <code>problem.json</code>（题型、提交模式、评测配置）与
        <code>evaluate.py</code>，题面放在 <code>statement.md</code>。可用
        <code>noj-cli problem lint</code> 本地校验、<code>noj-cli problem pack</code> 打包。
      </p>
    </div>

    <p
      v-if="importError"
      class="px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm"
    >
      {{ importError }}
    </p>

    <ZipDropZone :busy="importing" busy-hint="导入中..." @file="handleFile" />

    <label class="flex items-start gap-2 text-sm text-text">
      <input v-model="publish" type="checkbox" class="mt-0.5 size-4 accent-primary" :disabled="importing">
      <span>
        导入后立即发布
        <span class="block text-xs text-text-muted">
          不勾选时题目保存为草稿，跳转到编辑页核对题面与配置后再点「发布版本」；未发布的题目其他人看不到。
        </span>
      </span>
    </label>
  </div>
</template>
