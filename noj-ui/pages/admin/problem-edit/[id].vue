<script setup lang="ts">
import { ArrowLeft, Save, Eye, Edit3 } from "@lucide/vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { token, isLoggedIn, loading } = useAuth()
const router = useRouter()
const route = useRoute()
const problemId = route.params.id as string

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

const title = ref("")
const description = ref("")
const difficulty = ref("medium")
const judgeImage = ref("")
const judgeCommand = ref("")
const timeLimitMs = ref(5000)
const memoryLimitMb = ref(512)
const categoryIds = ref<string[]>([])
const pageLoading = ref(true)
const notFound = ref(false)
const loadError = ref("")
const categories = ref<{ id: string; name: string }[]>([])

async function loadData() {
  if (!token.value) return
  pageLoading.value = true
  try {
    const [catRes, problemRes] = await Promise.all([
      $fetch<{ data: { id: string; name: string }[] }>("/api/v1/categories"),
      $fetch<{ data: {
        title: string; description: string; difficulty: string
        judge_image: string; judge_command: string
        time_limit_ms: number; memory_limit_mb: number
        categories: { id: string }[]
      } }>(`/api/v1/problems/${problemId}`),
    ])
    categories.value = catRes.data
    const p = problemRes.data
    title.value = p.title; description.value = p.description
    difficulty.value = p.difficulty
    judgeImage.value = p.judge_image; judgeCommand.value = p.judge_command
    timeLimitMs.value = p.time_limit_ms; memoryLimitMb.value = p.memory_limit_mb
    categoryIds.value = p.categories.map((c) => c.id)
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      notFound.value = true
    } else {
      loadError.value = err instanceof Error ? err.message : "加载题目失败"
    }
  } finally {
    pageLoading.value = false
  }
}

watch(token, (val) => { if (val) loadData() }, { immediate: true })

const previewMode = ref(false)
const saving = ref(false)
const saveError = ref("")
const fieldErrors = ref<Record<string, string>>({})

function validate(): boolean {
  const errors: Record<string, string> = {}
  if (!title.value.trim()) errors.title = "请输入题目标题"
  if (!description.value.trim()) errors.description = "请输入题目描述"
  if (!judgeImage.value.trim()) errors.judge_image = "请输入评测镜像"
  if (!judgeCommand.value.trim()) errors.judge_command = "请输入评测命令"
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

async function handleSubmit() {
  if (!token.value || !validate()) return
  saving.value = true; saveError.value = ""
  try {
    await $fetch(`/api/v1/problems/${problemId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.value}` },
      body: {
        title: title.value.trim(), description: description.value.trim(),
        difficulty: difficulty.value,
        judge_image: judgeImage.value.trim(), judge_command: judgeCommand.value.trim(),
        time_limit_ms: timeLimitMs.value > 0 ? timeLimitMs.value : 5000,
        memory_limit_mb: memoryLimitMb.value > 0 ? memoryLimitMb.value : 512,
        category_ids: categoryIds.value.length > 0 ? categoryIds.value : undefined,
      },
    })
    router.replace("/admin/problems")
  } catch (err: unknown) {
    saveError.value = err instanceof Error ? err.message : "保存失败"
  } finally { saving.value = false }
}
</script>

<template>
  <div v-if="notFound" class="page">
    <p class="loading-text">题目不存在</p>
    <NuxtLink to="/admin/problems" class="back-link">返回题目列表</NuxtLink>
  </div>
  <div v-else-if="pageLoading" class="page">
    <p class="loading-text">加载中...</p>
  </div>
  <div v-else-if="loadError" class="page">
    <p class="loading-text">{{ loadError }}</p>
    <NuxtLink to="/admin/problems" class="back-link">返回题目列表</NuxtLink>
  </div>
  <div v-else class="page">
    <NuxtLink to="/admin/problems" class="back-link"><ArrowLeft :size="16" /> 返回题目列表</NuxtLink>
    <h1 class="title">编辑题目</h1>
    <div v-if="saveError" class="alert-error">{{ saveError }}</div>
    <div class="card">
      <section class="section">
        <h2 class="section-title">基本信息</h2>
        <div class="form-grid">
          <div class="field">
            <label class="label">标题 <span class="required">*</span></label>
            <input v-model="title" class="input" />
            <p v-if="fieldErrors.title" class="field-error">{{ fieldErrors.title }}</p>
          </div>
          <div class="field">
            <label class="label">难度</label>
            <select v-model="difficulty" class="input">
              <option value="easy">简单</option>
              <option value="medium">中等</option>
              <option value="hard">困难</option>
            </select>
          </div>
          <div class="field">
            <label class="label">分类</label>
            <div class="checkbox-group">
              <label v-for="cat in categories" :key="cat.id" class="checkbox-label">
                <input v-model="categoryIds" type="checkbox" :value="cat.id" class="checkbox" />{{ cat.name }}
              </label>
              <span v-if="categories.length === 0" class="text-muted">暂无分类</span>
            </div>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">题目描述 <span class="required">*</span></h2>
          <button class="toggle-preview" @click="previewMode = !previewMode">{{ previewMode ? "编辑" : "预览" }}</button>
        </div>
        <textarea v-if="!previewMode" v-model="description" class="textarea" rows="12" />
        <div v-else class="preview-box">
          <MarkdownRenderer v-if="description.trim()" :content="description" />
          <p v-else class="text-muted">暂无内容</p>
        </div>
      </section>
      <section class="section">
        <h2 class="section-title">评测配置</h2>
        <div class="form-grid">
          <div class="field">
            <label class="label">评测镜像 <span class="required">*</span></label>
            <input v-model="judgeImage" class="input" />
          </div>
          <div class="field">
            <label class="label">评测命令 <span class="required">*</span></label>
            <input v-model="judgeCommand" class="input" />
          </div>
          <div class="field">
            <label class="label">时间限制 (ms)</label>
            <input v-model.number="timeLimitMs" type="number" class="input" min="100" max="30000" />
          </div>
          <div class="field">
            <label class="label">内存限制 (MB)</label>
            <input v-model.number="memoryLimitMb" type="number" class="input" min="16" max="4096" />
          </div>
        </div>
      </section>
      <div class="form-actions">
        <NuxtLink to="/admin/problems" class="btn-cancel">取消</NuxtLink>
        <button class="btn-primary" :disabled="saving" @click="handleSubmit">{{ saving ? "保存中..." : "保存修改" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 800px; display: flex; flex-direction: column; gap: 16px; }
.back-link { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--c-text-secondary); text-decoration: none; }
.back-link:hover { color: var(--c-primary); }
.title { font-size: 22px; font-weight: 700; color: var(--c-text); margin: 0; }
.loading-text { text-align: center; padding: 48px; color: var(--c-text-secondary); font-size: 16px; }
.alert-error { padding: 10px 14px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #dc2626; font-size: 14px; }
.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: 10px; overflow: hidden; }
.section { padding: 20px 24px; border-bottom: 1px solid var(--c-border); }
.section:last-child { border-bottom: none; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.section-title { font-size: 15px; font-weight: 600; color: var(--c-text); margin: 0 0 12px 0; }
.section-header .section-title { margin-bottom: 0; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field:has(textarea), .field:has(.checkbox-group) { grid-column: 1 / -1; }
.label { font-size: 13px; font-weight: 600; color: var(--c-text); }
.required { color: #dc2626; }
.input { padding: 8px 12px; font-size: 14px; border: 1px solid var(--c-border); border-radius: 6px; outline: none; background: var(--c-white); }
.input:focus { border-color: var(--c-primary); box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1); }
.textarea { width: 100%; padding: 12px; font-size: 14px; font-family: ui-monospace, monospace; line-height: 1.6; border: 1px solid var(--c-border); border-radius: 6px; outline: none; resize: vertical; min-height: 200px; box-sizing: border-box; }
.textarea:focus { border-color: var(--c-primary); box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1); }
.preview-box { padding: 12px; border: 1px solid var(--c-border); border-radius: 6px; min-height: 200px; }
.toggle-preview { padding: 4px 10px; font-size: 12px; font-weight: 600; color: var(--c-text-secondary); background: transparent; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; }
.toggle-preview:hover { border-color: var(--c-text-secondary); }
.checkbox-group { display: flex; flex-wrap: wrap; gap: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.checkbox { accent-color: var(--c-primary); }
.text-muted { font-size: 13px; color: var(--c-text-muted); }
.field-error { font-size: 12px; color: #dc2626; }
.form-actions { display: flex; gap: 10px; justify-content: flex-end; padding: 16px 24px; }
.btn-primary { padding: 10px 20px; font-size: 14px; font-weight: 600; background: var(--c-primary); color: #fff; border: 1.5px solid var(--c-primary); border-radius: 8px; cursor: pointer; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel { padding: 10px 20px; font-size: 14px; font-weight: 600; color: var(--c-text-secondary); border: 1.5px solid var(--c-border); border-radius: 8px; cursor: pointer; text-decoration: none; }
</style>
