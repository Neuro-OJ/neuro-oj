<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

useRequireLogin()

interface AdminAnnouncement {
  id: string
  public_id?: string
  title: string
  content: string
  is_pinned: boolean
  is_active: boolean
  created_by: string
  created_at: string
  updated_at: string
}

const { api } = useApi()
const { isLoggedIn } = useAuth()

const { items, loading, error, load, onPageChange, currentPage, totalPages } = useAdminList<AdminAnnouncement>({
  path: "/api/v1/admin/announcements",
  fetchOptions: { dataField: "data", totalField: "meta.total" },
})

// 首次进入页面时自动加载存量公告（认证状态就绪后再请求，避免使用未登录态请求）
watch(isLoggedIn, (val) => {
  if (val) load()
}, { immediate: true })

const columns = [
  {
    accessorKey: "title",
    header: "标题",
    cell: (info: { getValue: () => string }) => {
      const v = info.getValue() as string
      return v.length > 30 ? `${v.slice(0, 30)}…` : v
    },
  },
  {
    accessorKey: "is_pinned",
    header: "置顶",
    cell: (info: { getValue: () => boolean }) => info.getValue() ? "是" : "否",
  },
  {
    accessorKey: "is_active",
    header: "状态",
    cell: (info: { getValue: () => boolean }) => info.getValue() ? "已发布" : "已下架",
  },
  {
    accessorKey: "updated_at",
    header: "更新时间",
    cell: (info: { getValue: () => string }) => {
      const d = new Date(info.getValue() as string)
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
    },
  },
  {
    accessorKey: "created_at",
    header: "创建时间",
    cell: (info: { getValue: () => string }) => {
      const d = new Date(info.getValue() as string)
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
    },
  },
  { accessorKey: "actions", header: "操作" },
]

// ── 新建/编辑表单 ──
const showForm = ref(false)
const editing = ref<AdminAnnouncement | null>(null)
const saving = ref(false)
const formError = ref("")
const formTitle = ref("")
const formContent = ref("")
const formPinned = ref(false)
const formActive = ref(true)

function openCreate() {
  editing.value = null
  formTitle.value = ""
  formContent.value = ""
  formPinned.value = false
  formActive.value = true
  formError.value = ""
  showForm.value = true
}

function openEdit(row: AdminAnnouncement) {
  editing.value = row
  formTitle.value = row.title
  formContent.value = row.content
  formPinned.value = row.is_pinned
  formActive.value = row.is_active
  formError.value = ""
  showForm.value = true
}

async function handleSave() {
  saving.value = true
  formError.value = ""
  try {
    const body = {
      title: formTitle.value,
      content: formContent.value,
      is_pinned: formPinned.value,
      is_active: formActive.value,
    }
    if (editing.value) {
      await api.put(`/api/v1/admin/announcements/${editing.value.public_id || editing.value.id}`, body)
    } else {
      await api.post("/api/v1/admin/announcements", body)
    }
    showForm.value = false
    await load(currentPage.value)
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}

// ── 删除确认 ──
const deleteTarget = ref<AdminAnnouncement | null>(null)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
// 删除错误独立于表单错误，避免两个 modal 间状态串台
const deleteError = ref("")

function confirmDelete(row: AdminAnnouncement) {
  deleteTarget.value = row
  deleteError.value = ""
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await api.delete(`/api/v1/admin/announcements/${deleteTarget.value.public_id || deleteTarget.value.id}`)
    showDeleteConfirm.value = false
    await load(currentPage.value)
  } catch (err: unknown) {
    deleteError.value = extractApiError(err).message
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="公告管理" description="发布系统公告，置顶公告将优先展示在首页轮播">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新建公告
        </UButton>
      </template>
    </PageHeader>

    <div v-if="error" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ error }}</span></div>
    <UTable
      :columns="columns"
      :data="items"
      :loading="loading"
      :empty="'暂无公告'">
      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row.original)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-red-50 hover:text-error-text hover:border-error-text/30" title="删除" aria-label="删除" @click="confirmDelete(row.original)">
            <UIcon name="i-lucide-trash-2" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </UTable>

    <PaginationNav
      v-if="totalPages > 1"
      :current-page="currentPage"
      :total-pages="totalPages"
      class="mt-2"
      @page-change="onPageChange"
    />
  </div>

  <!-- 新建/编辑弹窗 -->
  <UModal v-model:open="showForm" :title="editing ? '编辑公告' : '新建公告'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">标题 <span class="text-error-text">*</span></label>
          <input v-model="formTitle" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]" placeholder="公告标题（1–100 字符）" maxlength="100" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">内容（Markdown） <span class="text-error-text">*</span></label>
          <UTextarea v-model="formContent" :rows="10" maxlength="50000" placeholder="支持 Markdown 语法" />
        </div>
        <div class="flex items-center justify-between gap-4 pt-1">
          <label class="text-13px font-semibold text-text cursor-pointer select-none" for="ann-form-pinned">置顶展示</label>
          <USwitch v-model="formPinned" id="ann-form-pinned" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <label class="text-13px font-semibold text-text cursor-pointer select-none" for="ann-form-active">立即发布</label>
          <USwitch v-model="formActive" id="ann-form-active" />
        </div>
        <p class="text-12px text-text-muted">关闭「立即发布」后公告将保存为草稿，仅后台可见；发布状态可在编辑时随时切换（即发布/下架）。</p>
        <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showForm = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">{{ editing ? '保存' : '创建' }}</UButton>
    </template>
  </UModal>

  <!-- 删除确认弹窗 -->
  <UModal v-model:open="showDeleteConfirm" title="删除公告" :unmount-on-hide="true">
    <template #body>
      <p>确定要删除公告 <strong>{{ deleteTarget?.title }}</strong> 吗？此操作不可撤销。</p>
      <p v-if="deleteError" class="text-error-text text-13px">{{ deleteError }}</p>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">取消</UButton>
      <UButton color="error" :loading="deleting" @click="handleDelete">删除</UButton>
    </template>
  </UModal>
</template>
