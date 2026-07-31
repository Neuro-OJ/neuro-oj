<script setup lang="ts">
import SearchPalette from "~/components/feature/search/SearchPalette.vue";

const { state, open, close } = useSearch();

function onGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
    } else if (e.key === "Escape" && state.value.open) {
        close();
    }
}

onMounted(() => {
    window.addEventListener("keydown", onGlobalKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", onGlobalKeydown);
});
</script>
<template>
    <div class="flex flex-col min-h-screen w-full overflow-x-hidden">
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:bg-white focus:text-text focus:px-4 focus:py-2 focus:rounded-md focus:shadow-modal">
            跳转到主要内容
        </a>
        <Navbar />
        <div class="flex flex-1 min-h-[calc(100vh-var(--header-h))] w-full pt-(--header-h)">
            <main id="main" class="flex-1 min-w-0 w-full">
                <slot />
            </main>
        </div>
        <FooterBar />
        <SearchPalette />
    </div>
</template>

<style>
/* 动画关键帧 —— Tailwind animate-* 无法覆盖的自定义动画 */
@keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
}

@keyframes glow {
    from { text-shadow: 0 0 8px rgba(59, 130, 246, 0.3); }
    to { text-shadow: 0 0 20px rgba(59, 130, 246, 0.7); }
}

@keyframes fadeInUp {
    from { opacity: 0; transform: translateY(24px); }
    to { opacity: 1; transform: translateY(0); }
}

@keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
}
</style>
