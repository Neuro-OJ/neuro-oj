<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading: authLoading } = useAuth()
const router = useRouter()

watch(authLoading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

// ─── 类型 ────
interface IpBan {
  id: string
  ip_or_cidr: string
  reason: string
  expires_at: string | null
  created_at: string
  created_by: string | null
}

// ─── 数据加载 ────
const items = ref<IpBan[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const search = ref("")

async function load() {
  tableLoading.value = true
  tableError.value = ""
  try {
    const params = new URLSearchParams({ page: "1", per_page: "100" })
    if (search.value) params.set("keyword", search.value)
    const res = await $fetch<{ data: IpBan[]; pagination: { total: number } }>(
      `/api/v1/admin/blacklist?${params.toString()}`,
    )
    items.value = res.data
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载黑名单失败"
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => { if (val) load() }, { immediate: true })

// ─── 新增弹窗 ────
const showForm = ref(false)
const formError = ref("")
const form = reactive({ ip_or_cidr: "", reason: "", expires_at: "" })
const saving = ref(false)

function openCreate() {
  form.ip_or_cidr = ""
  form.reason = ""
  form.expires_at = ""
  formError.value = ""
  showForm.value = true
}

async function handleSave() {
  if (!form.ip_or_cidr.trim()) {
    formError.value = "请填写 IP 或 CIDR"
    return
  }
  saving.value = true
  formError.value = ""
  try {
    await $fetch("/api/v1/admin/blacklist", {
      method: "POST",
      body: {
        ip_or_cidr: form.ip_or_cidr.trim(),
        reason: form.reason.trim(),
        expires_at: form.expires_at.trim() || null,
      },
    })
    showForm.value = false
    toast.success("已添加黑名单条目")
    await load()
  } catch (err: unknown) {
    formError.value = err instanceof Error ? err.message : "添加失败"
  } finally {
    saving.value = false
  }
}

// ─── 删除确认 ────
const deleteTarget = ref<IpBan | null>(null)
const deleting = ref(false)
const { dialog } = useDialog()

async function confirmDelete(item: IpBan) {
  const ok = await dialog({
    title: "确认删除黑名单条目？",
    text: `将删除 ${item.ip_or_cidr}。此操作不可撤销。`,
    icon: "warning",
    danger: true,
    confirmText: "确认删除",
  })
  if (!ok) return
  deleteTarget.value = item
  deleting.value = true
  try {
    await $fetch(`/api/v1/admin/blacklist/${item.id}`, { method: "DELETE" })
    toast.success(`已删除 ${item.ip_or_cidr}`)
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "删除失败")
  } finally {
    deleting.value = false
    deleteTarget.value = null
  }
}

function formatExpires(value: string | null) {
  if (!value) return "永久"
  return new Date(value).toLocaleString("zh-CN")
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text">IP 黑名单管理</h1>
      <span class="text-sm text-text-secondary">
        拦截恶意 IP / CIDR 范围；命中后返 403 IP_BLACKLISTED
      </span>
    </div>

    <!-- 顶部操作栏 -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2">
        <input
          v-model="search"
          type="text"
          placeholder="搜索 IP 或 CIDR"
          class="px-3 py-1.5 text-sm border border-border rounded outline-none focus:border-primary"
          @keyup.enter="load"
        />
        <button
          class="px-3 py-1.5 text-sm border border-border rounded bg-white text-text hover:bg-gray-50 transition-colors"
          @click="load"
        >
          搜索
        </button>
      </div>
      <button
        class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-white bg-primary rounded cursor-pointer transition-colors hover:bg-primary-dark"
        @click="openCreate"
      >
        <Plus :size="14" />
        新增黑名单
      </button>
    </div>

    <!-- 错误条 -->
    <div
      v-if="tableError"
      class="p-3 bg-red-50 border border-red-200 rounded-md text-[13px] text-error-text"
    >
      {{ tableError }}
      <button class="ml-2 underline cursor-pointer" @click="load">重试</button>
    </div>

    <!-- 表格 -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div v-if="tableLoading" class="p-8 text-center text-sm text-text-secondary">
        加载中...
      </div>
      <div
        v-else-if="items.length === 0"
        class="p-8 text-center text-sm text-text-secondary"
      >
        暂无黑名单条目
      </div>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="bg-gray-50 border-b border-border">
            <th class="px-3 py-2.5 text-left font-semibold text-text w-[220px]">IP / CIDR</th>
            <th class="px-3 py-2.5 text-left font-semibold text-text">原因</th>
            <th class="px-3 py-2.5 text-left font-semibold text-text w-[200px]">过期时间</th>
            <th class="px-3 py-2.5 text-left font-semibold text-text w-[180px]">创建时间</th>
            <th class="px-3 py-2.5 text-right font-semibold text-text w-[100px]">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-b border-border last:border-b-0 hover:bg-gray-50 transition-colors"
          >
            <td class="px-3 py-2.5 align-top">
              <code class="font-mono text-[13px] font-semibold text-text">{{ item.ip_or_cidr }}</code>
            </td>
            <td class="px-3 py-2.5 align-top text-text-secondary">
              {{ item.reason || "—" }}
            </td>
            <td class="px-3 py-2.5 align-top text-text-secondary text-[13px]">
              {{ formatExpires(item.expires_at) }}
            </td>
            <td class="px-3 py-2.5 align-top text-text-secondary text-[13px]">
              {{ new Date(item.created_at).toLocaleString("zh-CN") }}
            </td>
            <td class="px-3 py-2.5 align-top">
              <div class="flex items-center justify-end">
                <button
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-semibold text-error-text bg-white border-[1.5px] border-border rounded cursor-pointer transition-all hover:border-error-text disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="deleting"
                  title="删除"
                  @click="confirmDelete(item)"
                >
                  <Trash2 :size="13" />
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 新增黑名单弹窗 -->
    <AdminModal
      v-if="showForm"
      title="新增 IP 黑名单"
      confirm-text="确认添加"
      :loading="saving"
      @confirm="handleSave"
      @cancel="showForm = false"
    >
      <div class="flex flex-col gap-3">
        <div>
          <label class="block text-sm font-semibold text-text mb-1">
            IP / CIDR <span class="text-error-text">*</span>
          </label>
          <input
            v-model="form.ip_or_cidr"
            placeholder="1.2.3.4 或 10.0.0.0/8"
            class="w-full px-3 py-2 text-sm font-mono border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          />
        </div>
        <div>
          <label class="block text-sm font-semibold text-text mb-1">原因</label>
          <input
            v-model="form.reason"
            placeholder="可选，例如：恶意刷接口"
            class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          />
        </div>
        <div>
          <label class="block text-sm font-semibold text-text mb-1">过期时间</label>
          <input
            v-model="form.expires_at"
            type="datetime-local"
            class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          />
          <p class="mt-1 text-[12px] text-text-secondary">留空表示永久封禁</p>
        </div>
        <p v-if="formError" class="text-[13px] text-error-text">{{ formError }}</p>
      </div>
    </AdminModal>
  </div>
</template>
