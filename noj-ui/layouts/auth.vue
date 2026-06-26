<template>
    <div class="flex flex-col min-h-screen">
        <Navbar />
        <main class="flex-1 min-h-[calc(100vh-64px)] px-6 py-28 flex items-center justify-center">
            <slot />
        </main>
        <FooterBar />
    </div>
</template>
