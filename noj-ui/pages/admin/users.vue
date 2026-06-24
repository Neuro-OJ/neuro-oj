<script setup lang="ts">
import { ShieldCheck, ShieldX, ShieldAlert } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { token, isLoggedIn, loading } = useAuth()
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
  if (!token.value) return
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: User[]; pagination: { total: number; total_pages: number } }>(
      `/api/v1/admin/users?page=${page}&per_page=${perPage}`,
      { headers: { Authorization: `Bearer ${token.value}` } },
    )
    users.value = res.data
    totalPages.value = res.pagination.total_pages
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载用户列表失败"
  } finally {
    tableLoading.value = false
  }
}

watch(token, (val) => {
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
  if (!targetUser.value || !token.value) return
  const newRole = targetUser.value.role === "admin" ? "user" : "admin"
  switchingRole.value = true
  switchError.value = ""
  try {
    await $fetch(`/api/v1/admin/users/${targetUser.value.id}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token.value}` },
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
  <div class="page">
    <div class="header">
      <h1 class="title">用户管理</h1>
      <span class="subtitle">管理所有用户的角色权限</span>
    </div>

    <AdminTable
      :columns="columns"
      :data="users"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无用户"
    >
      <template #cell-role="{ row }">
        <span class="role-badge" :class="row.role === 'admin' ? 'admin' : 'user'">
          <ShieldCheck v-if="row.role === 'admin'" :size="14" />
          <ShieldX v-else :size="14" />
          {{ row.role === "admin" ? "管理员" : "用户" }}
        </span>
      </template>

      <template #actions="{ row }">
        <button
          class="btn btn-xs"
          :class="row.role === 'admin' ? 'btn-outline-warning' : 'btn-outline-primary'"
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
    <p v-if="switchError" class="error-text">{{ switchError }}</p>
  </AdminModal>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
}

.subtitle {
  font-size: 14px;
  color: var(--c-text-secondary);
}

.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
}

.role-badge.admin {
  background: #eff6ff;
  color: #3b82f6;
}

.role-badge.user {
  background: #f5f5f5;
  color: #6b7280;
}

.btn-xs {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1.5px solid transparent;
}

.btn-outline-primary {
  color: #3b82f6;
  border-color: #3b82f6;
  background: transparent;
}

.btn-outline-primary:hover {
  background: #3b82f6;
  color: #fff;
}

.btn-outline-warning {
  color: #f59e0b;
  border-color: #f59e0b;
  background: transparent;
}

.btn-outline-warning:hover {
  background: #f59e0b;
  color: #fff;
}

.error-text {
  margin-top: 8px;
  color: #dc2626;
  font-size: 13px;
}
</style>
