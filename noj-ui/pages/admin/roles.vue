<script setup lang="ts">
import { Plus, Pencil, Trash2, Lock, ShieldCheck, AlertTriangle } from "@lucide/vue"
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

interface Permission {
  id: string
  resource: string
  action: string
  description: string
}

interface Role {
  id: string
  name: string
  description: string
  is_system: boolean
  is_default: boolean
  is_admin: boolean
  parent_id: string | null
  parent_name: string | null
  permissions: string[]
}

// 按 resource 分组的权限
interface PermissionGroup {
  resource: string
  items: Permission[]
}

const roles = ref<Role[]>([])
const permissions = ref<Permission[]>([])
const permissionGroups = computed<PermissionGroup[]>(() => {
  const map = new Map<string, Permission[]>()
  for (const p of permissions.value) {
    if (!map.has(p.resource)) map.set(p.resource, [])
    map.get(p.resource)!.push(p)
  }
  return Array.from(map.entries()).map(([resource, items]) => ({ resource, items }))
})

const tableLoading = ref(true)
const tableError = ref("")

const columns: Column<Role>[] = [
  { key: "name", label: "角色名" },
  {
    key: "parent_name",
    label: "继承自",
    format: (val) => (val as string) || "-",
  },
  {
    key: "is_admin",
    label: "管理员",
    format: (val) => (val as boolean) ? "是" : "否",
  },
  {
    key: "is_default",
    label: "默认角色",
    format: (val) => (val as boolean) ? "是" : "否",
  },
  {
    key: "is_system",
    label: "系统角色",
    format: (val) => (val as boolean) ? "是" : "否",
  },
]

async function loadRoles() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const [rolesRes, permsRes] = await Promise.all([
      $fetch<{ data: Role[] }>("/api/v1/admin/roles"),
      $fetch<{ data: Permission[] }>("/api/v1/admin/permissions"),
    ])
    roles.value = rolesRes.data
    permissions.value = permsRes.data
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    tableError.value = apiErr?.data?.error || apiErr?.message || "加载角色列表失败"
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadRoles()
}, { immediate: true })

// ─── 角色编辑器 ──────────────────────────────

const showEditor = ref(false)
const editingRole = ref<Role | null>(null)
const editorName = ref("")
const editorDesc = ref("")
const editorParentId = ref<string | null>(null)
const editorPermissionIds = ref<Set<string>>(new Set())
const editorError = ref("")
const saving = ref(false)

// 计算继承的权限 ID 集合（来自父角色的权限）
const inheritedPermissionIds = computed(() => {
  if (!editorParentId.value) return new Set<string>()
  const parent = roles.value.find(r => r.id === editorParentId.value)
  if (!parent) return new Set<string>()
  return new Set(parent.permissions)
})

function openNewRole() {
  editingRole.value = null
  editorName.value = ""
  editorDesc.value = ""
  editorParentId.value = null
  editorPermissionIds.value = new Set()
  editorError.value = ""
  showEditor.value = true
}

function openEditRole(role: Role) {
  editingRole.value = role
  editorName.value = role.name
  editorDesc.value = role.description || ""
  editorParentId.value = role.parent_id
  editorPermissionIds.value = new Set(role.permissions)
  editorError.value = ""
  showEditor.value = true
}

function togglePermission(permId: string) {
  const next = new Set(editorPermissionIds.value)
  if (next.has(permId)) next.delete(permId)
  else next.add(permId)
  editorPermissionIds.value = next
}

const availableParents = computed(() => {
  // 排除自己（编辑时）和 admin 角色（admin 不应有 parent_id）
  const excludeIds = new Set<string>()
  if (editingRole.value) excludeIds.add(editingRole.value.id)
  return roles.value.filter(r => !r.is_admin && !excludeIds.has(r.id))
})

async function handleSave() {
  if (!editorName.value.trim()) {
    editorError.value = "角色名不能为空"
    return
  }
  saving.value = true
  editorError.value = ""
  try {
    const body = {
      name: editorName.value.trim(),
      description: editorDesc.value.trim() || undefined,
      parent_id: editorParentId.value,
      permission_ids: Array.from(editorPermissionIds.value),
    }
    if (editingRole.value) {
      await $fetch(`/api/v1/admin/roles/${editingRole.value.id}`, {
        method: "PUT",
        body,
      })
    } else {
      await $fetch("/api/v1/admin/roles", {
        method: "POST",
        body,
      })
    }
    showEditor.value = false
    await loadRoles()
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    editorError.value = apiErr?.data?.error || apiErr?.message || "保存失败"
  } finally {
    saving.value = false
  }
}

// ─── 删除角色 ────────────────────────────────

const deletingId = ref<string | null>(null)
const deleteError = ref("")

async function confirmDelete(role: Role) {
  const { dialog } = useDialog()
  const ok = await dialog.confirm(
    `确定删除角色「${role.name}」？此操作不可撤销。`,
    { title: "确认删除角色？", confirmText: "删除" },
  )
  if (!ok) return

  deletingId.value = role.id
  deleteError.value = ""
  try {
    await $fetch(`/api/v1/admin/roles/${role.id}`, { method: "DELETE" })
    await loadRoles()
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    deleteError.value = apiErr?.data?.error || apiErr?.message || "删除失败"
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="角色管理" description="管理角色与权限分配" />

    <!-- 错误提示（删除失败） -->
    <div
      v-if="deleteError"
      class="flex items-center gap-2 px-4 py-3 text-sm text-error-text bg-red-50 border border-red-200 rounded-lg"
    >
      <AlertTriangle :size="16" />
      <span>{{ deleteError }}</span>
    </div>

    <div class="flex items-center justify-between">
      <div />
      <button
        class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-primary rounded-lg cursor-pointer transition-all hover:bg-primary-dark disabled:opacity-50"
        @click="openNewRole"
      >
        <Plus :size="16" />
        新建角色
      </button>
    </div>

    <AdminTable
      :columns="columns"
      :data="roles"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无角色"
    >
      <template #cell-name="{ row }">
        <div class="flex items-center gap-1.5">
          <ShieldCheck v-if="row.is_admin" :size="16" class="text-info-text shrink-0" />
          <span>{{ row.name }}</span>
          <Lock v-if="row.is_system" :size="14" class="text-text-muted shrink-0" title="系统角色" />
        </div>
      </template>

      <template #actions="{ row }">
        <div class="flex items-center gap-1.5">
          <button
            class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all border"
            :class="row.is_system
              ? 'border-border text-text-muted cursor-not-allowed opacity-50'
              : 'border-border text-text-secondary hover:bg-page hover:text-text'"
            :disabled="row.is_system"
            :title="row.is_system ? '系统角色不可编辑' : '编辑角色'"
            @click="openEditRole(row)"
          >
            <Pencil :size="14" />
            编辑
          </button>
          <button
            class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all border"
            :class="row.is_system
              ? 'border-border text-text-muted cursor-not-allowed opacity-50'
              : 'border-error-text text-error-text hover:bg-error-text hover:text-white'"
            :disabled="row.is_system || deletingId === row.id"
            :title="row.is_system ? '系统角色不可删除' : '删除角色'"
            @click="confirmDelete(row)"
          >
            <Trash2 :size="14" />
            {{ deletingId === row.id ? "删除中..." : "删除" }}
          </button>
        </div>
      </template>
    </AdminTable>
  </div>

  <!-- 角色编辑弹窗 -->
  <AdminModal
    v-if="showEditor"
    :title="editingRole ? `编辑角色：${editingRole.name}` : '新建角色'"
    :confirm-text="editingRole ? '保存' : '创建'"
    :loading="saving"
    @confirm="handleSave"
    @cancel="showEditor = false"
  >
    <div class="flex flex-col gap-4">
      <!-- 名称 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">角色名 *</label>
        <input
          v-model="editorName"
          placeholder="例如：moderator"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
          :disabled="editingRole?.is_system"
        />
      </div>

      <!-- 描述 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">描述</label>
        <input
          v-model="editorDesc"
          placeholder="角色用途说明"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
        />
      </div>

      <!-- 父角色 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">继承自</label>
        <select
          v-model="editorParentId"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white"
        >
          <option :value="null">（无）</option>
          <option
            v-for="p in availableParents"
            :key="p.id"
            :value="p.id"
          >
            {{ p.name }}
          </option>
        </select>
      </div>

      <!-- 权限勾选（仅非 admin 角色显示） -->
      <template v-if="!editingRole?.is_admin">
        <div class="border-t border-border pt-3">
          <label class="block text-sm font-semibold text-text mb-2">权限</label>
          <div class="max-h-[320px] overflow-y-auto space-y-3">
            <div
              v-for="group in permissionGroups"
              :key="group.resource"
              class="border border-border rounded-lg p-3"
            >
              <p class="text-xs font-bold text-text-muted uppercase mb-2">{{ group.resource }}</p>
              <div class="flex flex-col gap-1.5">
                <label
                  v-for="perm in group.items"
                  :key="perm.id"
                  class="flex items-center gap-2 text-sm cursor-pointer"
                  :class="{
                    'text-text-muted line-through': inheritedPermissionIds.has(perm.id),
                  }"
                >
                  <input
                    type="checkbox"
                    :checked="editorPermissionIds.has(perm.id)"
                    :disabled="inheritedPermissionIds.has(perm.id)"
                    class="accent-primary size-3.5"
                    @change="togglePermission(perm.id)"
                  />
                  <span>{{ perm.description }}</span>
                  <span
                    v-if="inheritedPermissionIds.has(perm.id)"
                    class="inline-flex items-center gap-0.5 text-xs text-text-muted"
                    title="来自继承角色"
                  >
                    <Lock :size="12" /> 继承
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- admin 角色提示 -->
      <div
        v-else
        class="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800"
      >
        <AlertTriangle :size="18" class="shrink-0 mt-0.5" />
        <span>⚠️ 管理员角色隐式拥有所有权限，无需单独配置</span>
      </div>

      <p v-if="editorError" class="text-[13px] text-error-text">{{ editorError }}</p>
    </div>
  </AdminModal>
</template>
