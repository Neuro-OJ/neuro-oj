import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * 将 Nuxt 编译期元变量替换为测试环境常量。
 * Vite 的 define 不支持替换 import.meta.client，因此用 transform 插件实现。
 */
function nuxtMetaPlugin() {
  return {
    name: 'nuxt-meta-replace',
    transform(code: string) {
      return code
        .replaceAll('import.meta.client', 'true')
        .replaceAll('import.meta.server', 'false')
        .replaceAll('import.meta.dev', 'true');
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  plugins: [vue(), nuxtMetaPlugin()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
  },
});
