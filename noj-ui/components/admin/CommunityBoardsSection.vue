<script setup lang="ts">
/**
 * 社区管理：讨论板块 section（板块列表 + 新建 + 归档）。
 * 从 admin/community.vue 拆出，状态自持，独立加载。
 */

interface Board {
  id: string
  name: string
  slug: string
  description: string | null
  is_archived: boolean
}

const { toast } = useToast()
const { api } = useApi()

const boards = ref<Board[]>([])
const newBoard = reactive({ slug: "", name: "", description: "" })
const creatingBoard = ref(false)

async function loadBoards() {
  const result = await api.get<{ data: Board[] }>("/api/v1/community/boards", { silent: true })
  boards.value = result.data
}

async function createBoard() {
  if (creatingBoard.value || !newBoard.slug || !newBoard.name) {
    if (!newBoard.slug || !newBoard.name) toast.warn("请填写板块 slug 和名称")
    return
  }
  creatingBoard.value = true
  try {
    await api.post("/api/v1/community/admin/boards", {
      slug: newBoard.slug, name: newBoard.name, description: newBoard.description,
    })
    toast.success("板块已创建")
    newBoard.slug = ""
    newBoard.name = ""
    newBoard.description = ""
    await loadBoards()
  } finally {
    creatingBoard.value = false
  }
}

async function toggleArchive(boardId: string, archived: boolean) {
  await api.patch(`/api/v1/community/admin/boards/${boardId}`, { is_archived: !archived })
  toast.success(archived ? "板块已恢复" : "板块已归档")
  await loadBoards()
}

// 初始加载
await loadBoards()
</script>

<template>
  <section class="rounded-lg border border-border bg-white p-5 shadow-card">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-layout-list" class="size-4.5" />
      <h2 class="font-semibold">讨论板块</h2>
    </div>
    <div class="mt-4 grid gap-3 md:grid-cols-2">
      <article v-for="board in boards" :key="board.id" class="rounded border border-border p-3">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h3 class="font-medium">{{ board.name }}</h3>
            <p class="mt-1 text-sm text-text-secondary">{{ board.description || '暂无描述' }}</p>
            <p class="mt-1 text-xs text-text-muted">{{ board.slug }}</p>
          </div>
          <UButton color="primary" variant="outline" class="text-xs" @click="toggleArchive(board.id, board.is_archived)">{{ board.is_archived ? '恢复' : '归档' }}</UButton>
        </div>
      </article>
    </div>
    <div class="mt-4 rounded border border-dashed border-border p-3">
      <p class="text-sm font-medium">新建板块</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <input v-model="newBoard.slug" class="w-32 rounded border border-border px-2 py-1 text-sm" placeholder="slug">
        <input v-model="newBoard.name" class="w-40 rounded border border-border px-2 py-1 text-sm" placeholder="名称">
        <input v-model="newBoard.description" class="w-52 flex-1 rounded border border-border px-2 py-1 text-sm" placeholder="描述（可选）">
        <UButton color="primary" class="text-sm" :disabled="creatingBoard" @click="createBoard">{{ creatingBoard ? '创建中…' : '创建' }}</UButton>
      </div>
    </div>
  </section>
</template>
