import { watch } from 'vue';
import type { Ref } from 'vue';

/**
 * 等待认证状态就绪（loading 结束），带 5s 超时兜底，
 * 防止后端不可达时路由守卫/页面卡死。
 * loading 已为 false 时立即返回。
 */
export async function waitAuthReady(loading: Ref<boolean>): Promise<void> {
  if (!loading.value) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      const unwatch = watch(loading, (val) => {
        if (!val) {
          unwatch();
          resolve();
        }
      });
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}
