<script setup lang="ts">
import { Pencil, Trash2, Reply } from "@lucide/vue"
import type { CommentRow } from "~/composables/useCommunity"

const props = defineProps<{
  row: CommentRow
  canComment: boolean
  canEdit: boolean
  commentMaxLength: number
}>()

const emit = defineEmits<{
  "start-reply": []
  "save-edit": [content: string]
  remove: []
}>()

const editing = ref(false)
const editContent = ref("")
const saving = ref(false)
const { toast } = useToast()

function startEdit() {
  editContent.value = props.row.comment.content
  editing.value = true
}

async function save() {
  const content = editContent.value.trim()
  if (!content || saving.value) return
  saving.value = true
  try {
    emit("save-edit", content)
    editing.value = false
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "编辑失败")
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <article class="rounded border border-border bg-white p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium">{{ row.author.username }}</span>
        <span v-if="row.comment.status === 'pending'" class="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">审核中</span>
        <span v-if="row.comment.status === 'hidden'" class="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">已隐藏</span>
        <NuxtTime :datetime="row.comment.created_at" relative locale="zh-CN" class="text-xs text-text-secondary" />
      </div>
      <div class="flex items-center gap-1">
        <button v-if="canComment && !row.comment.parent_id" type="button" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-primary-bg hover:text-primary" @click="emit('start-reply')"><Reply :size="13" />回复</button>
        <button v-if="canEdit" type="button" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-primary-bg hover:text-primary" @click="startEdit"><Pencil :size="13" />编辑</button>
        <button v-if="canEdit" type="button" class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50" @click="emit('remove')"><Trash2 :size="13" />删除</button>
      </div>
    </div>
    <template v-if="editing">
      <textarea v-model="editContent" class="mt-2 min-h-16 w-full rounded border border-border px-3 py-2" />
      <div class="mt-2 flex justify-end gap-2">
        <button class="btn-outline text-xs" type="button" @click="editing = false">取消</button>
        <button class="btn-primary text-xs" :disabled="saving || !editContent.trim() || editContent.length > commentMaxLength" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </template>
    <p v-else class="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{{ row.comment.content }}</p>
    <slot />
  </article>
</template>
