<script setup lang="ts">
const route = useRoute();
await navigateTo(
  `/d/main/problems/new?kind=${route.query.type === 'oi' ? 'oi' : 'ai'}`,
  { replace: true },
);
</script>
