<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
const {domain,status,error,refresh} = provideWorkspaceContext();
</script>
<template>
  <div class="min-h-dvh bg-bg-page">
    <AsyncContent :status="error ? 'error' : domain ? 'data' : status === 'pending' || status === 'idle' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="域不存在或不可访问" @retry="refresh()">
      <slot v-if="domain" />
    </AsyncContent>
  </div>
</template>
