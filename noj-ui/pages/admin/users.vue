<script setup lang="ts">
import { ShieldCheck, ShieldX, ShieldAlert } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"
import { useAdminList } from "~/composables/useAdminList"

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
  /** user-ban-table：活跃封禁信息 */
  active_ban: { reason: string; banned_until: string | null } | null
  created_at: string
  updated_at: string
}

const { items: users, totalPages, loading: tableLoading, error: tableError, currentPage, perPage, searchInput, load: loadUsers, onPageChange } = useAdminList<User>({
  path: "/api/v1/admin/users",
  fetchOptions: { dataField: "data", totalField: "pagination.total_pages" },
})

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

watch(isLoggedIn, (val) => {
  if (val) loadUsers()
}, { immediate: true })

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

// ─── 封禁 / 解封（issue #102）─────────────────────
const showBanModal = ref(false)
const banTarget = ref<User | null>(null)
const banForm = reactive({ reason: "", banned_until: "" })
const banning = ref(false)
const banError = ref("")
const { dialog } = useDialog()
const { toast } = useToast()

function confirmBan(user: User) {
  banTarget.value = user
  banForm.reason = ""
  banForm.banned_until = ""
  banError.value = ""
  showBanModal.value = true
}

async function handleBan() {
  if (!banTarget.value) return
  banning.value = true
  banError.value = ""
  try {
    await $fetch(`/api/v1/admin/users/${banTarget.value.id}/ban`, {
      method: "PATCH",
      body: {
        reason: banForm.reason.trim() || undefined,
        banned_until: banForm.banned_until
          ? new Date(banForm.banned_until).toISOString()
          : null,
      },
    })
    showBanModal.value = false
    toast.success(`已封禁 ${banTarget.value.username}`)
  } catch (err: unknown) {
    banError.value = err instanceof Error ? err.message : "封禁失败"
    banning.value = false
    return
  }
  try {
    await loadUsers(currentPage.value)
  } catch {
    // 刷新失败不影响操作成功
  } finally {
    banning.value = false
  }
}

async function confirmUnban(user: User) {
  const ok = await dialog.confirm(
    `将解除 ${user.username} 的封禁状态。此操作立即生效。`,
    { title: "确认解封用户？", confirmText: "确认解封" },
  )
  if (!ok) return
  banning.value = true
  try {
    await $fetch(`/api/v1/admin/users/${user.id}/unban`, { method: "PATCH" })
    toast.success(`已解封 ${user.username}`)
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "解封失败")
    banning.value = false
    return
  }
  try {
    await loadUsers(currentPage.value)
  } catch {
    // 刷新失败不影响操作成功
  } finally {
    banning.value = false
  }
}

// ─── 封禁历史（user-ban-table）─────────────────────
interface BanRecord {
  id: string
  reason: string
  banned_until: string | null
  banned_at: string
  banned_by: { id: string; username: string } | null
  unbanned_at: string | null
  unbanned_by: { id: string; username: string } | null
}

const showHistoryModal = ref(false)
const historyTarget = ref<User | null>(null)
const historyRecords = ref<BanRecord[]>([])
const historyLoading = ref(false)
const historyError = ref("")

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    })
  } catch { return iso }
}

async function showBanHistory(user: User) {
  historyTarget.value = user
  historyRecords.value = []
  historyError.value = ""
  historyLoading.value = true
  showHistoryModal.value = true
  try {
    const res = await $fetch<{ data: BanRecord[] }>(
      `/api/v1/admin/users/${user.id}/bans`,
    )
    historyRecords.value = res.data
  } catch (err: unknown) {
    historyError.value = err instanceof Error ? err.message : "加载封禁历史失败"
  } finally {
    historyLoading.value = false
  }
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
    <PageHeader title="用户管理" description="管理所有用户的角色权限" />

    <div class="flex items-center gap-2">
      <input
        type="text"
        placeholder="搜索用户名或邮箱…"
        class="w-full max-w-xs px-3 py-2 text-sm border border-border rounded-lg bg-white text-text placeholder-text-muted outline-none focus:border-info-text transition-colors"
        @input="searchInput(($event.target as HTMLInputElement).value)"
      />
    </div>

    <AdminTable
      :columns="columns"
      :data="users"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无用户"
    >
      <template #cell-role="{ row }">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span
            class="inline-flex items-center gap-1 px-2 py-[3px] rounded text-xs font-semibold"
            :class="row.role === 'admin' ? 'bg-blue-50 text-info-text' : 'bg-[#f5f5f5] text-[#6b7280]'"
          >
            <ShieldCheck v-if="row.role === 'admin'" :size="14" />
            <ShieldX v-else :size="14" />
            {{ row.role === "admin" ? "管理员" : "用户" }}
          </span>
          <!-- user-ban-table：封禁 badge -->
          <span
            v-if="row.active_ban"
            class="inline-flex items-center px-2 py-[3px] rounded text-xs font-semibold bg-red-50 text-error-text"
            :title="row.active_ban.banned_until ? `至 ${row.active_ban.banned_until} 解封` : '永久封禁'"
          >
            已封禁
          </span>
        </div>
      </template>

      <template #actions="{ row }">
        <div class="flex items-center gap-1.5">
          <button
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-transparent"
            :class="row.role === 'admin'
              ? 'text-warning-text border-warning-text bg-transparent hover:bg-warning-text hover:text-white'
              : 'text-info-text border-info-text bg-transparent hover:bg-info-text hover:text-white'"
            @click="confirmRoleSwitch(row)"
          >
            {{ row.role === "admin" ? "降为用户" : "设为管理员" }}
          </button>
          <!-- user-ban-table：封禁 / 解封 / 历史按钮 -->
          <button
            v-if="!row.active_ban"
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-error-text text-error-text bg-transparent hover:bg-error-text hover:text-white"
            :disabled="banning"
            @click="confirmBan(row)"
          >
            封禁
          </button>
          <button
            v-else
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-info-text text-info-text bg-transparent hover:bg-info-text hover:text-white"
            :disabled="banning"
            @click="confirmUnban(row)"
          >
            解封
          </button>
          <button
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-border text-text-secondary bg-transparent hover:bg-page hover:text-text"
            @click="showBanHistory(row)"
          >
            历史
          </button>
        </div>
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

  <!-- 封禁用户弹窗（issue #102） -->
  <AdminModal
    v-if="showBanModal"
    title="封禁用户"
    confirm-text="确认封禁"
    :loading="banning"
    danger
    @confirm="handleBan"
    @cancel="showBanModal = false"
  >
    <p class="mb-3">将封禁 <strong>{{ banTarget?.username }}</strong>。</p>
    <div class="flex flex-col gap-3">
      <div>
        <label class="block text-sm font-semibold text-text mb-1">封禁原因</label>
        <input
          v-model="banForm.reason"
          placeholder="例如：刷接口 / 提交作弊"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
        />
      </div>
      <div>
        <label class="block text-sm font-semibold text-text mb-1">到期时间</label>
        <input
          v-model="banForm.banned_until"
          type="datetime-local"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
        />
        <p class="mt-1 text-[12px] text-text-secondary">留空表示永久封禁</p>
      </div>
      <p v-if="banError" class="text-[13px] text-error-text">{{ banError }}</p>
    </div>
  </AdminModal>

  <!-- 封禁历史弹窗（user-ban-table） -->
  <AdminModal
    v-if="showHistoryModal"
    title="封禁历史"
    confirm-text=""
    :loading="historyLoading"
    @confirm="showHistoryModal = false"
    @cancel="showHistoryModal = false"
  >
    <p v-if="historyTarget" class="mb-3">
      <strong>{{ historyTarget.username }}</strong> 的封禁记录
    </p>
    <div v-if="historyLoading" class="text-center py-4 text-sm text-text-secondary">
      加载中...
    </div>
    <div v-else-if="historyError" class="text-error-text text-sm">
      {{ historyError }}
    </div>
    <div v-else-if="historyRecords.length === 0" class="text-center py-4 text-sm text-text-secondary">
      暂无封禁记录
    </div>
    <div v-else class="space-y-3 max-h-[400px] overflow-y-auto">
      <div
        v-for="rec in historyRecords"
        :key="rec.id"
        class="border border-border rounded-md p-3 text-sm"
      >
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">{{ rec.reason || '(无原因)' }}</span>
          <span
            class="text-xs px-2 py-0.5 rounded"
            :class="rec.unbanned_at ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'"
          >
            {{ rec.unbanned_at ? '已解封' : '封禁中' }}
          </span>
        </div>
        <div class="text-text-secondary text-xs space-y-0.5">
          <div>封禁于 {{ formatDate(rec.banned_at) }} — {{ rec.banned_by?.username || '系统' }}</div>
          <div v-if="rec.banned_until">到期：{{ formatDate(rec.banned_until) }}</div>
          <div v-if="rec.unbanned_at" class="text-green-700">
            解封于 {{ formatDate(rec.unbanned_at) }} — {{ rec.unbanned_by?.username || '系统' }}
          </div>
        </div>
      </div>
    </div>
  </AdminModal>
</template>
