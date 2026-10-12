<script setup lang="ts">
/**
 * 提交详情页的评测输出区。
 *
 * finished 与 error 两种终态都展示：error 提交的 output 携带评测机回传的错误说明
 * （如评测环境配置错误），出错时默认展开，方便提交者与管理员直接看到原因。
 * output 为 null 表示当前访问者无权查看（仅 owner/admin 可见）。
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  status: string
  output: string | null
  isLoggedIn: boolean
}>()

const emit = defineEmits<{
  copy: [text: string]
}>()

const isError = computed(() => props.status === 'error')
const expanded = ref(isError.value)

// 轮询中状态从 judging 变为 error 时自动展开
watch(isError, (val) => {
  if (val) expanded.value = true
})
</script>

<template>
  <div
    class="bg-[#0d1117] border rounded-xl overflow-hidden"
    :class="isError ? 'border-red-800' : 'border-[#30363d]'"
    data-testid="submission-output-panel"
  >
    <button
      class="flex items-center justify-between w-full px-4 py-3 bg-[#161b22] text-[#8b949e] text-xs font-mono border-b border-[#30363d] cursor-pointer hover:bg-[#1c2128]"
      @click="expanded = !expanded"
    >
      <span class="flex items-center gap-2">
        <UIcon :name="isError ? 'i-lucide-alert-triangle' : 'i-lucide-terminal'" class="size-4" />
        <span>{{ isError ? '错误信息' : '评测输出' }}</span>
      </span>
      <span class="flex items-center gap-2">
        <UIcon
          v-if="output != null"
          name="i-lucide-copy"
          class="size-4 hover:text-[#e6edf3]"
          title="复制评测输出"
          @click.stop="emit('copy', output)"
        />
        <UIcon name="i-lucide-chevron-down" class="size-4" v-if="!expanded"/>
        <UIcon name="i-lucide-chevron-up" class="size-4" v-else/>
      </span>
    </button>
    <pre v-if="output != null" v-show="expanded" class="p-4 overflow-x-auto text-xs leading-relaxed bg-[#0d1117] text-[#e6edf3]" data-testid="submission-output"><code class="font-mono whitespace-pre-wrap break-all">{{ output || '（无输出）' }}</code></pre>
    <div v-else class="flex flex-col items-center justify-center gap-2 py-8 text-text-muted text-sm">
      <UIcon name="i-lucide-lock" class="size-5" />
      <span>{{ isLoggedIn ? '仅提交者与管理员可查看评测输出' : '登录后查看评测输出' }}</span>
      <NuxtLink
        v-if="!isLoggedIn"
        to="/login"
        class="inline-flex items-center px-4 py-1.5 rounded-md text-xs font-semibold bg-signal text-on-signal border border-signal no-underline hover:bg-signal/80 hover:border-signal/80"
      >
        登录
      </NuxtLink>
    </div>
  </div>
</template>
