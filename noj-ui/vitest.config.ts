import { defineVitestConfig } from '@nuxt/test-utils/config';

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
  },
});
