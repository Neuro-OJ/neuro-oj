<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'
import { useToast } from '~/composables/useToast'
import { useDialog } from '~/composables/useDialog'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn } = useAuth()
const { api } = useApi()
const { toast } = useToast()
const { dialog } = useDialog()

useRequireLogin()

interface Tag {
  id: string
  name: string
  kind: 'problem' | 'algorithm'
  problem_count: number
  created_at: string
  updated_at: string
}

const tags = ref<Tag[]>([])
const tableLoading = ref(true)
const tableError = ref("")

const kindLabels: Record<Tag['kind'], string> = {
  problem: '题目标签',
  algorithm: '算法标签',
}

const columns = [
  { accessorKey: "name", header: "名称" },
  { accessorKey: "kind", header: "类型" },
  { accessorKey: "problem_count", header: "关联题目数" },
  { accessorKey: "created_at", header: "创建时间", cell: (info) => new Date(info.getValue() as string).toLocaleString("zh-CN") },
  { accessorKey: "actions", header: "操作" },
]

async function loadTags() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: Tag[] }>("/api/v1/tags", { silent: true })
    tags.value = res.data
  } catch (err: unknown) {
    tableError.value = extractApiError(err).message
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadTags()
}, { immediate: true })

// ── 创建/编辑弹窗 ──
const showForm = ref(false)
const editingTag = ref<Tag | null>(null)
const formName = ref("")
const formKind = ref<'problem' | 'algorithm'>('problem')
const saving = ref(false)
const formError = ref("")

function openCreate() {
  editingTag.value = null
  formName.value = ""
  formKind.value = "problem"
  formError.value = ""
  showForm.value = true
}

function openEdit(tag: Tag) {
  editingTag.value = tag
  formName.value = tag.name
  formKind.value = tag.kind
  formError.value = ""
  showForm.value = true
}

async function handleSave() {
  if (!formName.value.trim()) {
    formError.value = "名称不能为空"
    return
  }
  saving.value = true
  formError.value = ""
  try {
    if (editingTag.value) {
      await api.put(`/api/v1/tags/${editingTag.value.id}`, {
        name: formName.value.trim(),
        kind: formKind.value,
      })
      toast.success("标签已更新")
    } else {
      await api.post("/api/v1/tags", {
        name: formName.value.trim(),
        kind: formKind.value,
      })
      toast.success("标签已创建")
    }
    showForm.value = false
    await loadTags()
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}

// ── 合并弹窗 ──
const mergeSource = ref<Tag | null>(null)
const showMergeModal = ref(false)
const mergeTargetId = ref("")
const merging = ref(false)
const mergeError = ref("")

// 合并目标选项：排除源标签自身
const mergeTargetOptions = computed(() =>
  tags.value
    .filter((t) => t.id !== mergeSource.value?.id)
    .map((t) => ({ label: `${kindLabels[t.kind]}: ${t.name}`, value: t.id })),
)

function openMerge(tag: Tag) {
  mergeSource.value = tag
  mergeTargetId.value = ""
  mergeError.value = ""
  showMergeModal.value = true
}

async function handleMerge() {
  if (!mergeSource.value) return
  if (!mergeTargetId.value) {
    mergeError.value = "请选择目标标签"
    return
  }
  merging.value = true
  mergeError.value = ""
  try {
    await api.post(`/api/v1/tags/${mergeSource.value.id}/merge`, {
      target_id: mergeTargetId.value,
    })
    toast.success("标签已合并")
    showMergeModal.value = false
    await loadTags()
  } catch (err: unknown) {
    mergeError.value = extractApiError(err).message
  } finally {
    merging.value = false
  }
}

// ── 删除（useDialog danger 确认） ──
async function confirmDelete(tag: Tag) {
  const ok = await dialog({
    title: "确认删除标签？",
    text: `将删除「${tag.name}」（${kindLabels[tag.kind]}）。此操作不可撤销，关联题目将失去该标签。`,
    icon: "warning",
    danger: true,
    confirmText: "确认删除",
  })
  if (!ok) return
  try {
    await api.delete(`/api/v1/tags/${tag.id}`, { silent: true })
    toast.success(`已删除「${tag.name}」`)
    await loadTags()
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="标签管理" description="管理题目标签（problem）与算法标签（algorithm）">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新建标签
        </UButton>
      </template>
    </PageHeader>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="tags"
      :loading="tableLoading"
      :empty="'暂无标签'">
      <template #kind-cell="{ row }">
        <UBadge size="sm" variant="subtle" :color="row.original.kind === 'algorithm' ? 'secondary' : 'primary'">
          {{ kindLabels[row.original.kind] }}
        </UBadge>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row.original)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300" title="合并到其他标签" aria-label="合并" @click="openMerge(row.original)">
            <UIcon name="i-lucide-git-merge" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-red-50 hover:text-error-text hover:border-error-text/30" title="删除" aria-label="删除" @click="confirmDelete(row.original)">
            <UIcon name="i-lucide-trash-2" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </UTable>
  </div>

  <!-- 创建/编辑弹窗 -->
  <UModal v-model:open="showForm" :title="editingTag ? '编辑标签' : '新建标签'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
          <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="标签名称" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">类型 <span class="text-error-text">*</span></label>
          <USelect
            v-model="formKind"
            :items="[{ label: '题目标签', value: 'problem' }, { label: '算法标签', value: 'algorithm' }]"
            class="w-full"
          />
        </div>
        <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showForm = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">{{ editingTag ? '保存' : '创建' }}</UButton>
    </template>
  </UModal>

  <!-- 合并弹窗 -->
  <UModal v-model:open="showMergeModal" title="合并标签" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <p class="text-sm text-text-secondary">
          将标签 <strong class="text-text">{{ mergeSource?.name }}</strong> 合并到目标标签，源标签下的题目会转移到目标标签。
        </p>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">目标标签 <span class="text-error-text">*</span></label>
          <USelect
            v-model="mergeTargetId"
            :items="mergeTargetOptions"
            placeholder="选择目标标签"
            class="w-full"
          />
        </div>
        <p v-if="mergeError" class="text-error-text text-13px">{{ mergeError }}</p>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="merging" @click="showMergeModal = false">取消</UButton>
      <UButton color="primary" :loading="merging" @click="handleMerge">确认合并</UButton>
    </template>
  </UModal>
</template>
