<script setup lang="ts">
</script>
<template>
    <div class="flex flex-col min-h-screen w-full overflow-x-hidden">
        <Navbar />
        <div class="flex flex-1 min-h-[calc(100vh-64px)] w-full pt-16">
            <main class="flex-1 min-w-0 w-full">
                <slot />
            </main>
        </div>
        <FooterBar />
    </div>
</template>

<style>
/* 全局工具类 —— 由 Tailwind @apply 生成，迁移过渡期保留 */
.container {
    @apply mx-auto w-full;
    max-width: 1200px;
    padding: 0 24px;
}

.btn {
    @apply inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200;
}

.btn-primary {
    @apply bg-primary text-white border border-primary;
}

.btn-primary:hover {
    @apply bg-primary-dark border-primary-dark;
}

.btn-outline {
    @apply bg-transparent text-primary border border-primary;
}

.btn-outline:hover {
    @apply bg-primary text-white;
}
</style>

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
