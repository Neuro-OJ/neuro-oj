<template>
    <div class="flex flex-col min-h-screen">
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:bg-white focus:text-text focus:px-4 focus:py-2 focus:rounded-md focus:shadow-modal">
            跳转到主要内容
        </a>
        <Navbar />
        <main id="main" class="flex-1 min-h-[calc(100vh-var(--header-h))] px-6 py-28 flex items-center justify-center">
            <slot />
        </main>
        <FooterBar />
    </div>
</template>
