<template>
    <NuxtLayout>
        <NuxtPage />
    </NuxtLayout>
</template>

<style>
:root {
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
    overflow-x: hidden;
}

body {
    background: var(--c-bg-page);
    min-height: 100vh;
}
</style>
