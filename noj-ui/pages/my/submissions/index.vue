<script setup lang="ts">
// 旧目录固定属于默认域，保留单条本人历史的受控读取入口。
definePageMeta({ layout: false });
await navigateTo('/d/main/submissions', { redirectCode: 301, replace: true });
</script>
