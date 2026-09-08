// Vitest 全局设置：清理 DOM 与 Nuxt 运行时状态。
import { afterEach } from 'vitest';
import { cleanup } from '@vue/test-utils';

afterEach(() => {
  cleanup();
});
