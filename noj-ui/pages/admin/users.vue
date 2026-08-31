<script setup lang="ts">
import { useAdminList } from "~/composables/useAdminList"
import { extractApiError } from '~/utils/apiError'
import { useToast } from "~/composables/useToast"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

const { api } = useApi()

interface User {
  id: string
  username: string
  email: string
  is_admin: boolean
  role_ids: string[]
  /** user-ban-table：活跃封禁信息 */
  active_ban: { reason: string; banned_until: string | null; scope?: "platform" | "social" | null } | null
  created_at: string
  updated_at: string
}

// 自动轮询间隔（默认 30s，可由刷新控制条切换/关闭；封禁到期 badge 随刷新自动消失）
const pollInterval = ref<number | null>(30000)

const { items: users, totalPages, loading: tableLoading, error: tableError, currentPage, perPage, searchInput, load: loadUsers, onPageChange, lastRefresh } = useAdminList<User>({
  path: "/api/v1/admin/users",
  fetchOptions: { dataField: "data", totalField: "pagination.total" },
  polling: { intervalMs: pollInterval },
})

// 操作（封禁/解封/改角色）后刷新：若当前页超出总页数（删除/变更导致）则回退到最后一页，避免停在空页
async function reloadAfterMutation() {
  if (currentPage.value > totalPages.value && totalPages.value >= 1) {
    await loadUsers(totalPages.value)
  } else {
    await loadUsers(currentPage.value)
  }
}

const columns = [
  { accessorKey: "username", header: "用户名" },
  { accessorKey: "email", header: "邮箱" },
  {
    accessorKey: "role",
    header: "角色",
    cell: (info) => info.getValue() === "admin" ? "管理员" : "用户",
  },
  {
    accessorKey: "created_at",
    header: "注册时间",
    cell: (info) => {
      const d = new Date(info.getValue() as string)
      return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    },
  },

  { accessorKey: "actions", header: "操作" },]

watch(isLoggedIn, (val) => {
  if (val) loadUsers()
}, { immediate: true })

// ─── 角色管理（RBAC PATCH：role_ids）───────
interface Role {
  id: string
  name: string
  is_admin: boolean
  is_system: boolean
  is_default: boolean
}

const allRoles = ref<Role[]>([])
const targetUser = ref<User | null>(null)
const showRoleModal = ref(false)
const switchingRole = ref(false)
const switchError = ref("")
const selectedRoleIds = ref<string[]>([])

async function loadRoles() {
  try {
    const res = await api.get<{ data: Role[] }>("/api/v1/admin/roles", { silent: true })
    allRoles.value = res.data
  } catch {
    // 角色加载失败不影响用户列表
  }
}

function confirmRoleSwitch(user: User) {
  targetUser.value = user
  switchError.value = ""
  selectedRoleIds.value = [...user.role_ids]
  showRoleModal.value = true
  void loadRoles()
}

function toggleRoleId(roleId: string) {
  const idx = selectedRoleIds.value.indexOf(roleId)
  if (idx >= 0) {
    selectedRoleIds.value.splice(idx, 1)
  } else {
    selectedRoleIds.value.push(roleId)
  }
}

async function handleRoleSwitch() {
  if (!targetUser.value) return
  switchingRole.value = true
  switchError.value = ""
  try {
    await api.patch(`/api/v1/admin/users/${targetUser.value.username}/role`, {
      role_ids: selectedRoleIds.value,
    })
    showRoleModal.value = false
    await reloadAfterMutation()
  } catch (err: unknown) {
    switchError.value = extractApiError(err).message
  } finally {
    switchingRole.value = false
  }
}

// ─── 封禁 / 解封（issue #102）─────────────────────
const showBanModal = ref(false)
const banTarget = ref<User | null>(null)
const banForm = reactive({ reason: "", banned_until: "", scope: "platform" as "platform" | "social" })
const banning = ref(false)
const banError = ref("")
const { dialog } = useDialog()
const { toast } = useToast()

function confirmBan(user: User) {
  banTarget.value = user
  banForm.reason = ""
  banForm.banned_until = ""
  banForm.scope = "platform"
  banError.value = ""
  showBanModal.value = true
}

async function handleBan() {
  if (!banTarget.value) return
  banning.value = true
  banError.value = ""
  try {
    await api.patch(`/api/v1/admin/users/${banTarget.value.username}/ban`, {
      reason: banForm.reason.trim() || undefined,
      banned_until: banForm.banned_until
        ? new Date(banForm.banned_until).toISOString()
        : null,
      scope: banForm.scope,
    })
    showBanModal.value = false
    toast.success(`已封禁 ${banTarget.value.username}`)
  } catch (err: unknown) {
    banError.value = extractApiError(err).message
    banning.value = false
    return
  }
  try {
    await reloadAfterMutation()
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
    await api.patch(`/api/v1/admin/users/${user.username}/unban`)
    toast.success(`已解封 ${user.username}`)
  } catch {
    banning.value = false
    return
  }
  try {
    await reloadAfterMutation()
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
  scope: "platform" | "social"
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
    const res = await api.get<{ data: BanRecord[] }>(
      `/api/v1/admin/users/${user.username}/bans`,
      { silent: true },
    )
    historyRecords.value = res.data
  } catch (err: unknown) {
    historyError.value = extractApiError(err).message
  } finally {
    historyLoading.value = false
  }
}

</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="用户管理" description="管理所有用户的角色权限">
      <template #actions>
        <RefreshControl
          v-model:interval="pollInterval"
          :last-refresh="lastRefresh"
          @refresh="loadUsers(currentPage)"
        />
      </template>
    </PageHeader>

    <div class="flex items-center gap-2">
      <input
        type="text"
        placeholder="搜索用户名或邮箱…"
        class="w-full max-w-xs px-3 py-2 text-sm border border-border rounded-lg bg-white text-text placeholder-text-muted outline-none focus:border-info-text transition-colors"
        @input="searchInput(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="users"
      :loading="tableLoading"
      :empty="'暂无用户'">
      <template #role-cell="{ row }">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span
            class="inline-flex items-center gap-1 px-2 py-[3px] rounded text-xs font-semibold"
            :class="row.original.is_admin ? 'bg-blue-50 text-info-text' : 'bg-bg-page text-text-muted'"
          >
            <UIcon name="i-lucide-shield-check" class="size-3.5" v-if="row.original.is_admin"/>
            <UIcon name="i-lucide-shield-x" class="size-3.5" v-else/>
            {{ row.original.is_admin ? "管理员" : "用户" }}
          </span>
          <!-- user-ban-table：封禁 badge -->
          <span
            v-if="row.original.active_ban"
            class="inline-flex items-center px-2 py-[3px] rounded text-xs font-semibold bg-red-50 text-error-text"
            :title="row.original.active_ban.banned_until ? `至 ${row.original.active_ban.banned_until} 解封` : '永久封禁'"
          >
            {{ row.original.active_ban.scope === "social" ? "已封禁·仅社交" : "已封禁" }}
          </span>
        </div>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex items-center gap-1.5">
          <button
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-info-text text-info-text bg-transparent hover:bg-info-text hover:text-white"
            @click="confirmRoleSwitch(row.original)"
          >
            修改角色
          </button>
          <!-- user-ban-table：封禁 / 解封 / 历史按钮 -->
          <button
            v-if="!row.original.active_ban"
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-error-text text-error-text bg-transparent hover:bg-error-text hover:text-white"
            :disabled="banning"
            @click="confirmBan(row.original)"
          >
            封禁
          </button>
          <button
            v-else
            class="px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all duration-150 border-[1.5px] border-info-text text-info-text bg-transparent hover:bg-info-text hover:text-white"
            :disabled="banning"
            @click="confirmUnban(row.original)"
          >
            解封
          </button>
          <UButton color="neutral" variant="outline" size="sm" class="py-1 border-border text-text-secondary hover:bg-page hover:text-text" @click="showBanHistory(row.original)">
            历史
          </UButton>
        </div>
      </template>
    </UTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>

  <!-- 角色管理弹窗（RBAC role_ids） -->
  <UModal v-model:open="showRoleModal" title="修改用户角色" :unmount-on-hide="true">
    <template #body>
      <p class="mb-3">为用户 <strong>{{ targetUser?.username }}</strong> 选择角色：</p>
      <div class="flex flex-col gap-2 max-h-[300px] overflow-y-auto">
      <label
        v-for="role in allRoles"
        :key="role.id"
        class="flex items-center gap-2 p-2.5 border border-border rounded-lg cursor-pointer hover:bg-primary-bg transition-colors"
        :class="{ 'border-signal bg-primary-bg': selectedRoleIds.includes(role.id) }"
      >
        <input
          type="checkbox"
          :checked="selectedRoleIds.includes(role.id)"
          class="accent-primary size-4"
          @change="toggleRoleId(role.id)"
        />
        <div class="flex flex-col">
          <span class="text-sm font-semibold text-text">{{ role.name }}</span>
          <span v-if="role.is_admin" class="text-xs text-info-text">管理员角色（隐式全权限）</span>
          <span v-else-if="role.is_default" class="text-xs text-text-secondary">默认角色</span>
          <span v-else class="text-xs text-text-secondary">自定义角色</span>
        </div>
      </label>
      </div>
      <p v-if="switchError" class="mt-2 text-error-text text-13px">{{ switchError }}</p>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="switchingRole" @click="showRoleModal = false">取消</UButton>
      <UButton color="primary" :loading="switchingRole" @click="handleRoleSwitch">保存</UButton>
    </template>
  </UModal>

  <!-- 封禁用户弹窗（issue #102） -->
  <UModal v-model:open="showBanModal" title="封禁用户" :unmount-on-hide="true">
    <template #body>
      <p class="mb-3">将封禁 <strong>{{ banTarget?.username }}</strong>。</p>
      <div class="flex flex-col gap-3">
      <div>
        <label class="block text-sm font-semibold text-text mb-1">封禁类型</label>
        <div class="flex gap-4">
          <label class="flex items-center gap-2 text-sm">
            <input v-model="banForm.scope" type="radio" value="platform" class="accent-primary" />
            限制使用平台
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="banForm.scope" type="radio" value="social" class="accent-primary" />
            仅限制社交功能
          </label>
        </div>
        <p class="mt-1 text-[12px] text-text-secondary">平台封禁禁止登录与评测；社交封禁仅限制社区发布，仍可使用平台。</p>
      </div>
      <div>
        <label class="block text-sm font-semibold text-text mb-1">封禁原因</label>
        <input
          v-model="banForm.reason"
          placeholder="例如：刷接口 / 提交作弊"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        />
      </div>
      <div>
        <label class="block text-sm font-semibold text-text mb-1">到期时间</label>
        <input
          v-model="banForm.banned_until"
          type="datetime-local"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        />
        <p class="mt-1 text-[12px] text-text-secondary">留空表示永久封禁</p>
      </div>
        <p v-if="banError" class="text-13px text-error-text">{{ banError }}</p>
      </div>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="banning" @click="showBanModal = false">取消</UButton>
      <UButton color="error" :loading="banning" @click="handleBan">确认封禁</UButton>
    </template>
  </UModal>

  <!-- 封禁历史弹窗（user-ban-table） -->
  <UModal v-model:open="showHistoryModal" title="封禁历史" :unmount-on-hide="true">
    <template #body>
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
          <div class="flex items-center gap-2">
            <span
              class="text-xs px-2 py-0.5 rounded bg-gray-100 text-text-secondary"
            >
              {{ rec.scope === "social" ? "仅社交" : "平台封禁" }}
            </span>
            <span
              class="text-xs px-2 py-0.5 rounded"
              :class="rec.unbanned_at ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'"
            >
              {{ rec.unbanned_at ? '已解封' : '封禁中' }}
            </span>
          </div>
        </div>
        <div class="text-text-secondary text-xs space-y-0.5">
          <div>封禁于 {{ formatDate(rec.banned_at) }}，由 {{ rec.banned_by?.username || '系统' }}执行</div>
          <div v-if="rec.banned_until">到期：{{ formatDate(rec.banned_until) }}</div>
          <div v-if="rec.unbanned_at" class="text-green-700">
            解封于 {{ formatDate(rec.unbanned_at) }}，由 {{ rec.unbanned_by?.username || '系统' }}执行
          </div>
        </div>
        </div>
      </div>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="historyLoading" @click="showHistoryModal = false">取消</UButton>
    </template>
  </UModal>
</template>
