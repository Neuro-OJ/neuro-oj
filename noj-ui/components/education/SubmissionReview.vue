<script setup lang="ts">
defineProps<{ slug: string; classroomId: string; submissionId: string; canAnnotate: boolean }>();
</script>
<template>
  <div class="min-w-0 space-y-3">
    <p class="text-xs text-text-muted">批注固定在这份原提交上。个人笔记仅自己可见，发送后由学生与本域现任教师组查看。</p>
    <AnnotationCode :key="`${slug}:${submissionId}`" :slug="slug" :submission-id="submissionId" />
  </div>
</template>
