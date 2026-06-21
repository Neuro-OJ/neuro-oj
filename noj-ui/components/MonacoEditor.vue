<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue"

const props = defineProps<{
  modelValue: string
  language?: string
  disabled?: boolean
  minHeight?: number
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: any = null
let monacoModule: any = null
let modelContentDisposable: { dispose: () => void } | null = null

const MONACO_VERSION = "0.55.1" // 须与 package.json 中的 monaco-editor 版本一致

// Map our language identifiers to Monaco's
const langMap: Record<string, string> = {
  python3: "python",
  python: "python",
  cpp: "cpp",
  c: "c",
  javascript: "javascript",
  js: "javascript",
}

async function initMonaco() {
  if (!containerRef.value || !import.meta.client) return

  monacoModule = await import("monaco-editor")

  // CDN Worker — 避免 Vite ?worker 导入在 Nuxt SSR 下的兼容问题
  // 使用直接 CDN URL 而非 data: URI，避免违反 CSP worker-src
  const CDN_BASE = `https://unpkg.com/monaco-editor@${MONACO_VERSION}/min/vs`
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      const workerUrlMap: Record<string, string> = {
        typescript: `${CDN_BASE}/language/typescript/ts.worker.js`,
        javascript: `${CDN_BASE}/language/typescript/ts.worker.js`,
        json: `${CDN_BASE}/language/json/json.worker.js`,
        css: `${CDN_BASE}/language/css/css.worker.js`,
        html: `${CDN_BASE}/language/html/html.worker.js`,
      }
      return new Worker(workerUrlMap[label] || `${CDN_BASE}/editor/editor.worker.js`)
    },
  }

  const monaco = monacoModule

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: langMap[props.language ?? "python3"] || "python",
    theme: "vs-dark",
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    readOnly: props.disabled ?? false,
    tabSize: 4,
    insertSpaces: true,
    wordWrap: "on",
    padding: { top: 12, bottom: 12 },
    renderWhitespace: "selection",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
  })

  // Sync changes back to v-model
  modelContentDisposable = editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor.getValue())
  })
}

onMounted(initMonaco)

onUnmounted(() => {
  modelContentDisposable?.dispose()
  editor?.dispose()
})

// Sync external modelValue → editor（保留光标位置）
watch(
  () => props.modelValue,
  (val) => {
    if (editor && val !== editor.getValue()) {
      const pos = editor.getPosition()
      editor.setValue(val)
      if (pos) editor.setPosition(pos)
    }
  },
)

// Sync disabled changes
watch(
  () => props.disabled,
  (val) => {
    editor?.updateOptions({ readOnly: val ?? false })
  },
)

// Sync language changes
watch(
  () => props.language,
  (lang) => {
    if (!editor || !monacoModule) return
    const model = editor.getModel()
    if (model) {
      monacoModule.editor.setModelLanguage(model, langMap[lang ?? "python3"] || "python")
    }
  },
)
</script>

<template>
  <div ref="containerRef" class="w-full border border-border rounded-lg overflow-hidden" :style="{ minHeight: minHeight ? `${minHeight}px` : '320px' }" />
</template>
