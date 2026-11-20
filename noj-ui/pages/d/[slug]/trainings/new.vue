<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, domain, can } = useWorkspace();
useSeoMeta({ title: '创建域题单' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="创建题单" description="从当前域题库选题并安排顺序" />
    <ClientOnly v-if="domain?.status === 'active' && can('training:create')">
      <DomainTrainingEditor :slug="slug!" @saved="id => navigateTo(workspacePath(slug!, `trainings/${id}`))" />
    </ClientOnly>
    <UAlert v-else color="warning" title="当前域无法创建题单" />
  </div>
</template>
