<script setup lang="ts">
import { classroomCan } from '~/utils/education';
import type { ClassroomDetail } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';

const props = defineProps<{ slug: string; classroomId: string; classroom?: ClassroomDetail | null }>();
const route = useRoute();
const links = computed(() => {
  const base = workspacePath(props.slug, `classrooms/${props.classroomId}`);
  const room = props.classroom;
  return [
    { label: '班级概览', to: base },
    ...(room && (classroomCan(room, 'submissions:read') || classroomCan(room, 'progress:read'))
      ? [{ label: '学生训练', to: `${base}/students` }] : []),
    ...(room && classroomCan(room, 'students:manage') ? [{ label: '班级成员', to: `${base}/members` }] : []),
    ...(room && (room.manages_domain || room.membership?.role === 'coach')
      ? [{ label: '班级设置', to: `${base}/settings` }] : []),
  ];
});
function active(to: string) {
  return route.path === to || (to.endsWith('/students') && route.path.startsWith(`${to}/`));
}
</script>

<template>
  <nav aria-label="班级导航" class="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border text-sm">
    <NuxtLink :to="workspacePath(slug, 'classrooms')"
      class="inline-flex items-center gap-1 py-3 text-text-secondary hover:text-primary">
      <UIcon name="i-lucide-arrow-left" class="size-4" />我的班级
    </NuxtLink>
    <NuxtLink v-for="link in links" :key="link.to" :to="link.to"
      :aria-current="active(link.to) ? route.path === link.to ? 'page' : 'location' : undefined"
      class="border-b-2 py-3 font-medium transition-colors"
      :class="active(link.to) ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:border-border hover:text-text'">
      {{ link.label }}
    </NuxtLink>
  </nav>
</template>
