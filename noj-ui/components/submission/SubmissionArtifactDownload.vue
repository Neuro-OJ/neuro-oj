<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ endpoint: string; fileName: string }>();
const { api } = useApi();
const downloading = ref(false), failure = ref('');
async function download() {
  if (downloading.value) return;
  downloading.value = true;
  failure.value = '';
  try {
    const artifact = await api.get<Blob>(props.endpoint, { responseType: 'blob', silent: true });
    const url = URL.createObjectURL(artifact), link = document.createElement('a');
    try {
      link.href = url;
      link.download = props.fileName;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    // ofetch 的 blob 模式也将非 2xx 的 JSON 错误体解析为 Blob。
    const data = (error as { data?: unknown })?.data;
    const decoded = data instanceof Blob
      ? await data.text().then((text) => JSON.parse(text)).catch(() => null)
      : null;
    failure.value = extractApiError(decoded ? { ...error as object, data: decoded } : error).message;
  } finally {
    downloading.value = false;
  }
}
</script>
<template>
  <div class="space-y-2">
    <UButton variant="outline" icon="i-lucide-download" :loading="downloading" @click="download">下载原提交产物</UButton>
    <UAlert v-if="failure" color="error" :title="failure" />
  </div>
</template>
