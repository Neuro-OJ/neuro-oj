<script setup lang="ts">
import { ShieldCheck, ShieldX, ShieldAlert } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface User {
  id: string
  username: string
  email: string
  role: string
  created_at: string
  updated_at: string
}

const users = ref<User[]>([])
const currentPage = ref(1)
const totalPages = ref(1)
const tableLoading = ref(true)
const tableError = ref("")
const perPage = 20

const columns: Column<User>[] = [
  { key: "username", label: "用户名" },
  { key: "email", label: "邮箱" },
  {
    key: "role",
    label: "角色",
    format: (val) => val === "admin" ? "管理员" : "用户",
  },
  {
    key: "created_at",
    label: "注册时间",
    format: (val) => {
      const d = new Date(val as string)
      return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    },
  },
]

async function loadUsers(page = 1) {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: User[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/admin/users?page=${page}&per_page=${perPage}`,
    )
    users.value = res.data
    totalPages.value = res.pagination.total_pages
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载用户列表失败"
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadUsers()
}, { immediate: true })

function onPageChange(page: number) {
  loadUsers(page)
}

// 角色切换
const targetUser = ref<User | null>(null)
const showRoleModal = ref(false)
const switchingRole = ref(false)
const switchError = ref("")

function confirmRoleSwitch(user: User) {
  targetUser.value = user
  switchError.value = ""
  showRoleModal.value = true
}

async function handleRoleSwitch() {
  if (!targetUser.value) return
  const newRole = targetUser.value.role === "admin" ? "user" : "admin"
  switchingRole.value = true
  switchError.value = ""
  try {
    await $fetch(`/api/v1/admin/users/${targetUser.value.id}/role`, {
      method: "PATCH",
      body: { role: newRole },
    })
    showRoleModal.value = false
    await loadUsers(currentPage.value)
  } catch (err: unknown) {
    switchError.value = err instanceof Error ? err.message : "操作失败"
  } finally {
    switchingRole.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text">用户管理</h1>
      <span class="text-sm text-text-secondary">管理所有用户的角色权限</span>
    </div>

    <AdminTable
      :columns="columns"
      :data="users"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无用户"
    >
      <template #cell-role="{ row }">
        <span
          class="inline-flex items-center gap-1 px-2 py-[3px] rounded text-xs font-semibold"
          :class="row.role === 'admin' ? 'bg-blue-50 text-info-text' : 'bg-[#f5f5f5] text-[#6b7280]'"
        >
          <ShieldCheck v-if="row.role === 'admin'" :size="14" />
          <ShieldX v-else :size="14" />
          {{ row.role === "admin" ? "管理员" : "用户" }}
        </span>
      </template>

      <template #actions="{ row }">
        <button
          class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-transparent"
          :class="row.role === 'admin'
            ? 'text-warning-text border-warning-text bg-transparent hover:bg-warning-text hover:text-white'
            : 'text-info-text border-info-text bg-transparent hover:bg-info-text hover:text-white'"
          @click="confirmRoleSwitch(row)"
        >
          {{ row.role === "admin" ? "降为用户" : "设为管理员" }}
        </button>
      </template>
    </AdminTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>

  <!-- 角色切换确认弹窗 -->
  <AdminModal
    v-if="showRoleModal"
    :title="`${targetUser?.role === 'admin' ? '降级' : '提升'}用户`"
    :confirm-text="targetUser?.role === 'admin' ? '确认降级' : '确认提升'"
    :loading="switchingRole"
    :danger="targetUser?.role === 'admin'"
    @confirm="handleRoleSwitch"
    @cancel="showRoleModal = false"
  >
    <p>确定将 <strong>{{ targetUser?.username }}</strong> 的角色从
    <strong>{{ targetUser?.role === "admin" ? "管理员" : "普通用户" }}</strong>
    改为 <strong>{{ targetUser?.role === "admin" ? "普通用户" : "管理员" }}</strong> 吗？</p>
    <p v-if="switchError" class="mt-2 text-error-text text-[13px]">{{ switchError }}</p>
  </AdminModal>
</template>
