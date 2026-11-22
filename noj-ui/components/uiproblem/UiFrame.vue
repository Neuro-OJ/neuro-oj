<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildUiFrameDoc, sameValues, type UiFrameResult } from '~/utils/uiFrame'

/**
 * 界面题的沙箱 iframe：渲染题包自带的 `ui.html`，并与宿主页用 postMessage 通信。
 *
 * 安全边界：
 * - `sandbox="allow-scripts"`（**不含** allow-same-origin）：界面运行在不透明源里，
 *   读不到站点 cookie / localStorage，也无法调用同源 API；
 * - 文档头部注入 CSP（`default-src 'none'`）：界面不能发起任何网络请求；
 * - 宿主只接受 `event.source === iframe.contentWindow` 的消息，并只信任消息里的
 *   `values` 对象（真正的合法性校验仍在服务端）。
 *
 * 协议与界面侧 SDK（`window.NOJ`）见 `utils/uiFrame.ts`。
 */
const props = defineProps<{
  /** 题包里的 ui.html 原文 */
  html: string
  /** 当前参数（宿主为准；外部变化如回滚会推送给界面） */
  values: Record<string, unknown>
  /** 是否允许操作（未登录/比赛未开始等：界面进入只读） */
  disabled?: boolean
  /** 最近一次运行（自测/提交）的状态，推送给界面展示 */
  result?: UiFrameResult | null
  /** 题目标题等上下文，随 init 下发 */
  title?: string
}>()

const emit = defineEmits<{
  'update:values': [values: Record<string, unknown>]
  submit: []
  'self-test': []
}>()

const frame = ref<HTMLIFrameElement | null>(null)
const srcdoc = computed(() => buildUiFrameDoc(props.html))

/** 界面已就绪（收到 ready 并已下发 init）。 */
let ready = false
/** 最近一次来自界面的参数：与宿主当前值相同时不回推，避免回声与光标跳动。 */
let lastFromFrame: Record<string, unknown> | null = null

function post(message: Record<string, unknown>) {
  // 协议只承载 JSON；发送前生成普通快照，避免 Vue Proxy 无法被 postMessage 克隆。
  const snapshot = JSON.parse(JSON.stringify({ source: 'noj-host', ...message }))
  frame.value?.contentWindow?.postMessage(snapshot, '*')
}

function sendInit() {
  post({
    type: 'init',
    values: props.values,
    disabled: !!props.disabled,
    title: props.title ?? '',
    result: props.result ?? null,
  })
  ready = true
}

function onMessage(event: MessageEvent) {
  // 只接受自己 iframe 发来的消息（sandbox 下 origin 为 'null'，不能靠 origin 判断）
  if (event.source !== frame.value?.contentWindow) return
  const data = event.data as { source?: string; type?: string; values?: unknown } | null
  if (!data || data.source !== 'noj-ui') return
  switch (data.type) {
    case 'ready':
      sendInit()
      break
    case 'values': {
      if (props.disabled) return
      const values = data.values
      if (typeof values !== 'object' || values === null || Array.isArray(values)) return
      lastFromFrame = values as Record<string, unknown>
      emit('update:values', lastFromFrame)
      break
    }
    case 'submit':
      if (!props.disabled) emit('submit')
      break
    case 'self-test':
      if (!props.disabled) emit('self-test')
      break
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

// 外部改动（回滚 / 恢复草稿）→ 推送给界面；界面自己发出的变化不回推
watch(
  () => props.values,
  (values) => {
    if (!ready) return
    if (lastFromFrame && sameValues(lastFromFrame, values)) return
    post({ type: 'set', values })
  },
  { deep: true },
)

watch(() => props.disabled, (disabled) => {
  if (ready) post({ type: 'disabled', disabled: !!disabled })
})

watch(() => props.result, (result) => {
  if (ready) post({ type: 'result', result: result ?? null })
}, { deep: true })

// html 变化（切换题目/版本）→ iframe 重载，需等待新的 ready
watch(srcdoc, () => {
  ready = false
  lastFromFrame = null
})
</script>

<template>
  <iframe
    ref="frame"
    :srcdoc="srcdoc"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    title="题目界面"
    class="h-full w-full border-0 bg-white"
  />
</template>
