<script setup lang="ts">
import { MessageSquare } from "@lucide/vue"
import { useRouter } from "vue-router"
import ChatSidebar from "~/components/ChatSidebar.vue"

definePageMeta({
  middleware: "auth",
})

const router = useRouter()

function onSelect(id: string) {
  router.push(`/messages/${id}`)
}
</script>

<template>
  <div class="flex h-[calc(100vh-4rem)] max-w-[1000px] mx-auto">
    <!-- 左侧会话列表 -->
    <div class="w-[280px] flex-shrink-0">
      <ChatSidebar @select="onSelect" />
    </div>

    <!-- 右侧占位 -->
    <div class="flex-1 flex items-center justify-center bg-page">
      <div class="flex flex-col items-center text-text-secondary">
        <MessageSquare :size="48" class="mb-4 opacity-30" />
        <p class="text-lg">选择一个会话</p>
        <p class="text-sm mt-1">从左侧列表选择或浏览用户主页发送私信</p>
      </div>
    </div>
  </div>
</template>
