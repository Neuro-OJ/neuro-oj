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

  // Import monaco-editor — only runs on client
  monacoModule = await import("monaco-editor")

  // Use CDN-based workers (avoids Vite worker bundling complexity in Nuxt)
  const MONACO_CDN = "https://unpkg.com/monaco-editor@0.52.2/min/vs"
  self.MonacoEnvironment = {
    getWorkerUrl(_workerId: string, _label: string) {
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
        self.MonacoEnvironment = { baseUrl: "${MONACO_CDN}" };
        importScripts("${MONACO_CDN}/base/worker/workerMain.js");
      `)}`
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
  editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor.getValue())
  })
}

onMounted(initMonaco)

onUnmounted(() => {
  editor?.dispose()
})

// Sync external modelValue changes back to editor
watch(
  () => props.modelValue,
  (val) => {
    if (editor && val !== editor.getValue()) {
      editor.setValue(val)
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
  <div ref="containerRef" class="monaco-container" :style="{ minHeight: minHeight ? `${minHeight}px` : '320px' }" />
</template>

<style scoped>
.monaco-container {
  width: 100%;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  overflow: hidden;
}
</style>
