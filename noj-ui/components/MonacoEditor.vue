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

  // Worker 从 Nuxt 静态资源加载（self-host 模式，issue #82）
  // 避免国内网络下 unpkg.com 不可达导致 worker 拉取失败。
  // 文件名带 hash，由 postinstall 脚本扫描并写入 workers.json。
  const CDN_BASE = `/monaco`
  const manifest = (await fetch(`${CDN_BASE}/workers.json`).then((r) => r.json())) ?? {}
  const editorWorkerUrl = manifest.editor ? `${CDN_BASE}/${manifest.editor}` : null
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      const specific = manifest.workers?.[label]
      if (specific) return new Worker(`${CDN_BASE}/${specific}`)
      // python / 其他基础语言：通用 editor worker 即可处理高亮
      if (editorWorkerUrl) return new Worker(editorWorkerUrl)
      // 极端兜底（不应该走到这里）
      throw new Error(`No worker available for label=${label}`)
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
