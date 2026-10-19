<script setup lang="ts">
import type { AnnotationTarget } from '~/utils/annotations';
defineProps<{ annotation?: { slug: string; target: AnnotationTarget } }>();
</script>
<template>
  <AnnotationSurface v-if="annotation" :slug="annotation.slug" :target="annotation.target"><slot /></AnnotationSurface>
  <slot v-else />
</template>
