<script setup lang="ts">
// 旧搜索网址固定进入默认域，不再提供跨域业务汇总。
definePageMeta({ layout: false });
const route = useRoute();
await navigateTo({ path: '/d/main/search', query: route.query }, { redirectCode: 301, replace: true });
</script>
