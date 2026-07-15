<template>
    <header class="fixed top-0 left-0 right-0 z-[100] bg-white border-b border-border">
        <!-- 临时密码提示横幅 -->
        <div v-if="user?.must_change_password === true" class="w-full bg-red-50 border-b border-red-200 px-6 py-2 text-center">
            <p class="text-sm text-red-700">检测到当前密码为临时密码，首次登录后必须修改密码才能使用完整功能。</p>
        </div>
        <div class="w-full max-w-none mx-0 px-6 h-16 flex items-center" :class="user?.must_change_password === true ? 'h-14' : 'h-16'">
            <BrandLogo />
            <nav class="flex items-center gap-1 ml-6">
                <NuxtLink to="/" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">首页</NuxtLink>
                <NuxtLink to="/problems" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">题库</NuxtLink>
                <NuxtLink to="/ranking" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">榜单</NuxtLink>
                <NuxtLink to="/submissions" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">提交记录</NuxtLink>
                <NuxtLink to="/queue" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">队列</NuxtLink>
                <NuxtLink to="/about" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">关于</NuxtLink>
            </nav>
            <button
                type="button"
                class="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:bg-gray-100 rounded-md transition-colors"
                @click="openSearch"
            >
                <SearchIcon class="w-4 h-4" />
                <span>搜索</span>
                <kbd class="hidden md:inline-block px-1.5 py-0.5 text-xs bg-gray-100 border border-border rounded">Ctrl K</kbd>
            </button>
            <div class="flex items-center gap-3 ml-auto">
                <UserMenu />
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">
import { Search as SearchIcon } from "@lucide/vue";
const { user } = useAuth();
const { open: openSearch } = useSearch();
</script>
