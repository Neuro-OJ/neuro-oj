<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue"

const props = defineProps<{
  modelValue: string
  language?: string
  disabled?: boolean
  minHeight?: number
  theme?: "vs" | "vs-dark"
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "cursorChange", pos: { line: number; col: number }): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: any = null
let monacoModule: any = null
let modelContentDisposable: { dispose: () => void } | null = null

const MONACO_VERSION = "0.55.1" // 须与 package.json 中的 monaco-editor 版本一致

// 字号（响应 Ctrl/Cmd + 滚轮缩放）
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 32
const DEFAULT_FONT_SIZE = 14
let currentFontSize = DEFAULT_FONT_SIZE

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
  // 文件名带 hash，由 postinstall 脚本（scripts/copy-monaco.mjs）扫描并写入 workers.json。
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
    theme: props.theme ?? "vs-dark",
    minimap: { enabled: false },
    fontSize: currentFontSize,
    fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    fontLigatures: true,
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
    mouseWheelZoom: false, // 我们自己实现 Ctrl+滚轮缩放
  })

  // Sync changes back to v-model
  modelContentDisposable = editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor.getValue())
  })

  // Emit cursor position changes
  editor.onDidChangeCursorPosition((e: any) => {
    emit("cursorChange", { line: e.position.lineNumber, col: e.position.column })
  })
}

// Ctrl/Cmd + 滚轮：缩放编辑器字号
// 用 window + capture 阶段监听，避免 Monaco 内部或浏览器默认行为先消费事件
function onWheelZoom(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  // 只在鼠标位于编辑器容器内时拦截，避免影响其他区域
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  const inside =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top && e.clientY <= rect.bottom
  if (!inside) return
  e.preventDefault()
  e.stopPropagation()
  const delta = e.deltaY > 0 ? -1 : 1
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, currentFontSize + delta))
  if (next === currentFontSize) return
  currentFontSize = next
  editor?.updateOptions({ fontSize: next })
}

onMounted(() => {
  // window + capture: true，确保在 Monaco 之前先拿到事件
  window.addEventListener("wheel", onWheelZoom, { passive: false, capture: true })
})

onMounted(initMonaco)

onUnmounted(() => {
  window.removeEventListener("wheel", onWheelZoom, { capture: true } as EventListenerOptions)
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

// Sync theme changes
watch(
  () => props.theme,
  (t) => {
    if (editor && t) {
      monacoModule.editor.setTheme(t)
    }
  },
)
</script>

<template>
  <div ref="containerRef" class="w-full h-full overflow-hidden" :style="{ minHeight: minHeight ? `${minHeight}px` : '320px' }" />
</template>
