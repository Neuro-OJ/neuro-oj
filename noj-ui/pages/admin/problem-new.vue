<script setup lang="ts">
import { ArrowLeft, Save, Eye, Edit3 } from "@lucide/vue"

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

// 表单数据
const title = ref("")
const description = ref("")
const difficulty = ref("medium")
const judgeImage = ref("")
const judgeCommand = ref("")
const timeLimitMs = ref(5000)
const memoryLimitMb = ref(512)
const categoryIds = ref<string[]>([])

// 分类选项
const categories = ref<{ id: string; name: string }[]>([])

async function loadCategories() {
  try {
    const res = await $fetch<{ data: { id: string; name: string }[] }>("/api/v1/categories")
    categories.value = res.data
  } catch {
    // 静默失败，不影响主表单
  }
}

onMounted(() => loadCategories())

// 预览模式
const previewMode = ref(false)

// 提交
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
  if (!validate()) return

  saving.value = true
  saveError.value = ""
  try {
    await $fetch("/api/v1/problems", {
      method: "POST",
      body: {
        title: title.value.trim(),
        description: description.value.trim(),
        difficulty: difficulty.value,
        judge_image: judgeImage.value.trim(),
        judge_command: judgeCommand.value.trim(),
        time_limit_ms: timeLimitMs.value > 0 ? timeLimitMs.value : 5000,
        memory_limit_mb: memoryLimitMb.value > 0 ? memoryLimitMb.value : 512,
        category_ids: categoryIds.value.length > 0 ? categoryIds.value : undefined,
      },
    })
    router.replace("/admin/problems")
  } catch (err: unknown) {
    saveError.value = err instanceof Error ? err.message : "创建失败"
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <NuxtLink to="/admin/problems" class="back-link">
      <ArrowLeft :size="16" />
      返回题目列表
    </NuxtLink>

    <h1 class="title">创建题目</h1>

    <!-- 错误提示 -->
    <div v-if="saveError" class="alert-error">{{ saveError }}</div>

    <div class="card">
      <!-- 基本信息 -->
      <section class="section">
        <h2 class="section-title">基本信息</h2>
        <div class="form-grid">
          <div class="field">
            <label class="label">标题 <span class="required">*</span></label>
            <input v-model="title" class="input" placeholder="题目标题" />
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
                <input
                  v-model="categoryIds"
                  type="checkbox"
                  :value="cat.id"
                  class="checkbox"
                />
                {{ cat.name }}
              </label>
              <span v-if="categories.length === 0" class="text-muted">暂无分类</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 题目描述 -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">题目描述 <span class="required">*</span></h2>
          <button class="toggle-preview" @click="previewMode = !previewMode">
            <Eye v-if="!previewMode" :size="14" />
            <Edit3 v-else :size="14" />
            {{ previewMode ? "编辑" : "预览" }}
          </button>
        </div>
        <p v-if="fieldErrors.description" class="field-error">{{ fieldErrors.description }}</p>

        <textarea
          v-if="!previewMode"
          v-model="description"
          class="textarea"
          placeholder="支持 Markdown 格式的题目描述..."
          rows="12"
        />
        <div v-else class="preview-box">
          <MarkdownRenderer v-if="description.trim()" :content="description" />
          <p v-else class="text-muted">暂无内容</p>
        </div>
      </section>

      <!-- 评测配置 -->
      <section class="section">
        <h2 class="section-title">评测配置</h2>
        <div class="form-grid">
          <div class="field">
            <label class="label">评测镜像 <span class="required">*</span></label>
            <input v-model="judgeImage" class="input" placeholder="如：noj-judge-python" />
            <p v-if="fieldErrors.judge_image" class="field-error">{{ fieldErrors.judge_image }}</p>
          </div>

          <div class="field">
            <label class="label">评测命令 <span class="required">*</span></label>
            <input v-model="judgeCommand" class="input" placeholder="如：python3 /tmp/evaluate.py" />
            <p v-if="fieldErrors.judge_command" class="field-error">{{ fieldErrors.judge_command }}</p>
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

      <!-- 提交按钮 -->
      <div class="form-actions">
        <NuxtLink to="/admin/problems" class="btn btn-cancel">取消</NuxtLink>
        <button class="btn btn-primary" :disabled="saving" @click="handleSubmit">
          <Save :size="16" />
          {{ saving ? "创建中..." : "创建题目" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 800px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--c-text-secondary);
  text-decoration: none;
  transition: color 0.15s;
}

.back-link:hover {
  color: var(--c-primary);
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
  margin: 0;
}

.alert-error {
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #dc2626;
  font-size: 14px;
}

.card {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow: hidden;
}

.section {
  padding: 20px 24px;
  border-bottom: 1px solid var(--c-border);
}

.section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
  margin: 0 0 12px 0;
}

.section-header .section-title {
  margin-bottom: 0;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field:has(textarea),
.field:has(.checkbox-group) {
  grid-column: 1 / -1;
}

.label {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.required {
  color: #dc2626;
}

.input {
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
  background: var(--c-white);
}

.input:focus {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.textarea {
  width: 100%;
  padding: 12px;
  font-size: 14px;
  font-family: ui-monospace, monospace;
  line-height: 1.6;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  outline: none;
  resize: vertical;
  min-height: 200px;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.textarea:focus {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.preview-box {
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  min-height: 200px;
}

.toggle-preview {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-secondary);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.toggle-preview:hover {
  border-color: var(--c-text-secondary);
  color: var(--c-text);
}

.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--c-text);
  cursor: pointer;
}

.checkbox {
  accent-color: var(--c-primary);
}

.text-muted {
  font-size: 13px;
  color: var(--c-text-muted);
}

.field-error {
  font-size: 12px;
  color: #dc2626;
}

.form-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 16px 24px;
  border-top: 1px solid var(--c-border);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
  border: 1.5px solid transparent;
  line-height: 1;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--c-primary);
  color: var(--c-white);
  border-color: var(--c-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--c-primary-dark);
  border-color: var(--c-primary-dark);
}

.btn-cancel {
  color: var(--c-text-secondary);
  border-color: var(--c-border);
  background: transparent;
}

.btn-cancel:hover {
  border-color: var(--c-text-secondary);
}
</style>
