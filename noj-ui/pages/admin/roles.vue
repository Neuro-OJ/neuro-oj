<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

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

const { api } = useApi()

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

const columns: TableColumn<Role>[] = [
  { accessorKey: "name", header: "角色名" },
  {
    accessorKey: "parent_name",
    header: "继承自",
    cell: (info) => (info.getValue() as string) || "-",
  },
  {
    accessorKey: "is_admin",
    header: "管理员",
    cell: (info) => (info.getValue() as boolean) ? "是" : "否",
  },
  {
    accessorKey: "is_default",
    header: "默认角色",
    cell: (info) => (info.getValue() as boolean) ? "是" : "否",
  },
  {
    accessorKey: "is_system",
    header: "系统角色",
    cell: (info) => (info.getValue() as boolean) ? "是" : "否",
  },

  { accessorKey: "actions", header: "操作" },]

async function loadRoles() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const [rolesRes, permsRes] = await Promise.all([
      api.get<{ data: Role[] }>("/api/v1/admin/roles", { silent: true }),
      api.get<{ data: Permission[] }>("/api/v1/admin/permissions", { silent: true }),
    ])
    roles.value = rolesRes.data
    permissions.value = permsRes.data
  } catch (err: unknown) {
    tableError.value = extractApiError(err).message
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
const editorParentId = ref<string>('__none__')
const editorPermissionIds = ref<Set<string>>(new Set())
const editorError = ref("")
const saving = ref(false)

// 计算继承的权限 ID 集合（来自父角色的权限）
const inheritedPermissionIds = computed(() => {
  if (!editorParentId.value || editorParentId.value === '__none__') return new Set<string>()
  const parent = roles.value.find(r => r.id === editorParentId.value)
  if (!parent) return new Set<string>()
  return new Set(parent.permissions)
})

function openNewRole() {
  editingRole.value = null
  editorName.value = ""
  editorDesc.value = ""
  editorParentId.value = '__none__'
  editorPermissionIds.value = new Set()
  editorError.value = ""
  showEditor.value = true
}

function openEditRole(role: Role) {
  editingRole.value = role
  editorName.value = role.name
  editorDesc.value = role.description || ""
  editorParentId.value = role.parent_id ?? '__none__'
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
      parent_id: editorParentId.value === '__none__' ? null : editorParentId.value,
      permission_ids: Array.from(editorPermissionIds.value),
    }
    if (editingRole.value) {
      await api.put(`/api/v1/admin/roles/${editingRole.value.id}`, body)
    } else {
      await api.post("/api/v1/admin/roles", body)
    }
    showEditor.value = false
    await loadRoles()
  } catch (err: unknown) {
    editorError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}

// ─── 删除角色 ────────────────────────────────

const deletingId = ref<string | null>(null)
const deleteError = ref("")

async function confirmDelete(role: Role) {
  // 系统角色禁止删除（前端拦截，后端亦有校验）
  if (role.is_system) {
    deleteError.value = "系统角色不可删除"
    return
  }
  const { dialog } = useDialog()
  const ok = await dialog.confirm(
    `确定删除角色「${role.name}」？此操作不可撤销。`,
    { title: "确认删除角色？", confirmText: "删除" },
  )
  if (!ok) return

  deletingId.value = role.id
  deleteError.value = ""
  try {
    await api.delete(`/api/v1/admin/roles/${role.id}`)
    await loadRoles()
  } catch (err: unknown) {
    deleteError.value = extractApiError(err).message
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
      <UIcon name="i-lucide-alert-triangle" class="size-4" />
      <span>{{ deleteError }}</span>
    </div>

    <div class="flex items-center justify-between">
      <div />
      <UButton color="primary" size="sm" @click="openNewRole">
        <UIcon name="i-lucide-plus" class="size-4" />
        新建角色
      </UButton>
    </div>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="roles"
      :loading="tableLoading"
      :empty="'暂无角色'">
      <template #name-cell="{ row }">
        <div class="flex items-center gap-1.5">
          <UIcon name="i-lucide-shield-check" class="text-info-text shrink-0 size-4" v-if="row.original.is_admin"/>
          <span>{{ row.original.name }}</span>
          <UIcon name="i-lucide-lock" class="text-text-muted shrink-0 size-3.5" v-if="row.original.is_system"   title="系统角色"/>
        </div>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex items-center gap-1.5">
          <button
            class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all border"
            :class="row.original.is_system
              ? 'border-border text-text-muted cursor-not-allowed opacity-50'
              : 'border-border text-text-secondary hover:bg-page hover:text-text'"
            :disabled="row.original.is_system"
            :title="row.original.is_system ? '系统角色不可编辑' : '编辑角色'"
            @click="openEditRole(row.original)"
          >
            <UIcon name="i-lucide-pencil" class="size-3.5" />
            编辑
          </button>
          <button
            class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-all border"
            :class="row.original.is_system
              ? 'border-border text-text-muted cursor-not-allowed opacity-50'
              : 'border-error-text text-error-text hover:bg-error-text hover:text-white'"
            :disabled="row.original.is_system || deletingId === row.id"
            :title="row.original.is_system ? '系统角色不可删除' : '删除角色'"
            @click="confirmDelete(row.original)"
          >
            <UIcon name="i-lucide-trash-2" class="size-3.5" />
            {{ deletingId === row.original.id ? "删除中..." : "删除" }}
          </button>
        </div>
      </template>
    </UTable>
  </div>

  <!-- 角色编辑弹窗 -->
  <UModal v-model:open="showEditor" :title="editingRole ? `编辑角色：${editingRole.name}` : '新建角色'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-4">
      <!-- 名称 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">角色名 *</label>
        <input
          v-model="editorName"
          placeholder="例如：moderator"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
          :disabled="editingRole?.is_system"
        />
      </div>

      <!-- 描述 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">描述</label>
        <input
          v-model="editorDesc"
          placeholder="角色用途说明"
          class="w-full px-3 py-2 text-sm border border-border rounded outline-none focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        />
      </div>

      <!-- 父角色 -->
      <div>
        <label class="block text-sm font-semibold text-text mb-1">继承自</label>
        <USelect
          v-model="editorParentId"
          :items="[
            { label: '（无）', value: '__none__' },
            ...availableParents.map((p) => ({ label: p.name, value: p.id })),
          ]"
          class="w-full"
        />
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
                    <UIcon name="i-lucide-lock" class="size-3" /> 继承
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
        <UIcon name="i-lucide-alert-triangle" class="shrink-0 mt-0.5 size-4.5" />
        <span>管理员角色隐式拥有所有权限，无需单独配置</span>
      </div>

      <p v-if="editorError" class="text-13px text-error-text">{{ editorError }}</p>
      </div>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showEditor = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">{{ editingRole ? '保存' : '创建' }}</UButton>
    </template>
  </UModal>
</template>
