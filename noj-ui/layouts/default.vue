<script setup lang="ts">
</script>
<template>
    <div class="layout">
        <Navbar />
        <div class="body-area">
            <Sidebar />
            <main class="main">
                <slot />
            </main>
        </div>
        <FooterBar />
    </div>
</template>

<style>
:root { /* TODO 主题颜色是否为蓝色 */
    --c-primary: #2563eb;
    --c-primary-dark: #1d4ed8;
    --c-primary-light: #3b82f6;
    --c-primary-bg: #eff6ff;
    --c-primary-hover-bg: #dbeafe;
    --c-primary-active-bg: #bfdbfe;
    --c-primary-text: #1e40af;

    --c-bg-dark: #0f172a;
    --c-bg-dark-2: #1e293b;
    --c-bg-dark-3: #334155;

    --c-text: #1e293b;
    --c-text-secondary: #64748b;
    --c-text-muted: #94a3b8;

    --c-border: #e2e8f0;
    --c-bg-page: #f8fafc;
    --c-white: #ffffff;
}

*,
*::before,
*::after {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

html {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--c-text);
    scroll-behavior: smooth;
}

body {
    background: var(--c-bg-page);
    min-height: 100vh;
}

.layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
}

.body-area {
    display: flex;
    flex: 1;
    min-height: calc(100vh - 64px);
}

.main {
    flex: 1;
    min-width: 0;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 24px;
}

.btn {
    border-radius: 8px;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.btn-primary {
    background: var(--c-primary);
    color: var(--c-white);
    border: 1.5px solid var(--c-primary);
}

.btn-primary:hover {
    background: var(--c-primary-dark);
    border-color: var(--c-primary-dark);
}
</style>

<style>
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
    from {
        opacity: 0;
        transform: translateY(24px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
}
</style>
