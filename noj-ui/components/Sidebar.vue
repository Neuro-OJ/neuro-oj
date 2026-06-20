<template>
    <aside class="sidebar">
        <div class="sidebar-inner">
            <nav class="nav-links">
                <NuxtLink to="/" class="nav-link">
                    <House class="nav-icon" />
                    <span class="nav-text">首页</span>
                </NuxtLink>
                <NuxtLink to="/problems" class="nav-link">
                    <FileText class="nav-icon" />
                    <span class="nav-text">题库</span>
                </NuxtLink>
            </nav>
        </div>
    </aside>
</template>

<script setup lang="ts">
import { House, FileText, Trophy, BarChart3 } from "@lucide/vue"
</script>

<style scoped>
.sidebar {
    position: sticky;
    top: 64px;
    width: 60px;
    height: calc(100vh - 64px);
    background: var(--c-white);
    border-right: 1px solid var(--c-border);
    z-index: 99;
    overflow: hidden;
    white-space: nowrap;
    transition: width 0.25s ease;
    flex-shrink: 0;
}

.sidebar:hover {
    width: 200px;
}

.sidebar-inner {
    padding: 16px 8px;
}

.nav-links {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.nav-link {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border-radius: 8px;
    text-decoration: none;
    color: var(--c-text-secondary);
    font-size: 15px;
    font-weight: 500;
    transition: background 0.2s, color 0.2s;
}

.nav-link:hover {
    background: var(--c-primary-hover-bg);
    color: var(--c-primary);
}

.nav-icon {
    width: 20px;
    height: 20px;
    min-width: 20px;
}

.nav-text {
    opacity: 0;
    transition: opacity 0.15s ease;
}

.sidebar:hover .nav-text {
    opacity: 1;
}
</style>
