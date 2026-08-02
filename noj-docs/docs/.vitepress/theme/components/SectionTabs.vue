<script setup>
import { computed } from 'vue'
import { useData, useRoute } from 'vitepress'

const route = useRoute()
const { frontmatter } = useData()

const tabs = [
  { text: '做题人', link: '/users/', matchers: ['/users/'] },
  { text: '运营者', link: '/operators/', matchers: ['/operators/'] },
  { text: '出题人', link: '/problemsetters/', matchers: ['/problemsetters/'] },
  { text: '参考', link: '/reference/', matchers: ['/reference/'] },
]

const isHome = computed(() => route.path === '/' || route.path === '/index.html')

const shouldShow = computed(
  () =>
    frontmatter.value.layout !== false &&
    frontmatter.value.layout !== 'home' &&
    !isHome.value,
)

function isActive(tab) {
  return tab.matchers.some(prefix => route.path.startsWith(prefix))
}
</script>

<template>
  <template v-if="shouldShow">
    <div class="VPSectionTabsPlaceholder" aria-hidden="true" />
    <div class="VPSectionTabs">
      <div class="container">
        <a
          v-for="tab in tabs"
          :key="tab.link"
          class="tab"
          :class="{ active: isActive(tab) }"
          :href="tab.link"
        >
          {{ tab.text }}
        </a>
      </div>
    </div>
  </template>
</template>

<style scoped>
.VPSectionTabs {
  display: none;
}

.VPSectionTabsPlaceholder {
  display: none;
}

@media (min-width: 1280px) {
  .VPSectionTabsPlaceholder {
    display: block;
    height: var(--vp-section-tabs-height, 44px);
  }

  .VPSectionTabs {
    display: block;
    position: fixed;
    left: 0;
    right: 0;
    top: calc(var(--vp-layout-top-height, 0px) + var(--vp-nav-height));
    z-index: 26;
    border-bottom: 1px solid var(--vp-c-gutter);
    background-color: var(--vp-nav-bg-color);
  }

  .container {
    margin: 0 auto;
    max-width: var(--vp-layout-max-width);
    display: flex;
    align-items: flex-end;
    gap: 10px;
    box-sizing: border-box;
    height: var(--vp-section-tabs-height, 44px);
    padding: 0 32px 8px;
  }

  .tab {
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 13px;
    line-height: 20px;
    color: var(--vp-c-text-2);
    white-space: nowrap;
    transition: color 0.2s ease, background-color 0.2s ease;
  }

  .tab:hover {
    color: var(--vp-c-text-1);
    background-color: var(--vp-c-default-soft);
  }

  .tab.active {
    color: var(--vp-c-brand-1);
    background-color: var(--vp-c-brand-soft);
  }
}
</style>
