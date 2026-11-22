/**
 * useBreadcrumb 调用时序回归测试（#512 评审修正）。
 *
 * 背景：评审实测两页 SSR 500——
 *   `useBreadcrumbLabel(() => detail.value?.title)` 写在 `const detail = ref(...)` **之前**，
 * 早先 composable 用**立即执行**的 `watchEffect`，同步求值 getter 时抛
 * `ReferenceError: Cannot access 'detail' before initialization`。
 *
 * **本测试的关键是「真实执行 getter」**：初版把 `watchEffect` 换成只收集回调、
 * 从不执行的桩件，导致把本 spec 原样拷到修复前的树上也能全绿——等于没有防线。
 * 这里改为**记录并真实执行**回调（模拟 Vue 的 post-flush 语义），
 * 并对 getter 的调用次数做断言，从而真正锁住「setup 阶段不得求值」这一约束。
 */
import { describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

/** 收集待执行的回调（模拟 onMounted / post-flush watchEffect 队列）。 */
let pendingCbs: Array<{ cb: () => void; eager: boolean }> = [];

vi.stubGlobal('useRoute', () => ({ path: '/announcements/ann-1', meta: {} }));
vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
vi.stubGlobal('onScopeDispose', () => {});
vi.stubGlobal('onMounted', (cb: () => void) => {
  pendingCbs.push({ cb, eager: false });
});
// 关键：记录 flush 选项。若代码用**立即执行**（无 flush: 'post'），
// 这里同步执行——正是修复前会抛 TDZ 的行为；带 post 则推迟到 flushPending。
vi.stubGlobal('watchEffect', (cb: () => void, opts?: { flush?: string }) => {
  const eager = opts?.flush !== 'post';
  if (eager) cb();
  else pendingCbs.push({ cb, eager: false });
});
vi.stubGlobal('computed', computed);

const { useBreadcrumbLabel } = await import('~/composables/useBreadcrumb');

/** 执行所有挂起回调（模拟 mounted / post-flush）。 */
function flushPending() {
  const cbs = pendingCbs;
  pendingCbs = [];
  for (const { cb } of cbs) cb();
}

describe('useBreadcrumbLabel 调用时序', () => {
  it('在 const ref 声明之前调用不抛错（TDZ 回归防线）', () => {
    pendingCbs = [];
    // 复刻页面真实写法：先调用，后声明 const（块级作用域）
    const run = () => {
      // getter 通过闭包捕获 holder，holder 在被调用**之后**才持有 ref。
      const holder: {
        ref: ReturnType<typeof ref<{ title: string } | null>> | null;
      } = { ref: null };
      useBreadcrumbLabel(() => holder.ref?.value?.title);
      // 模拟 const ref 的声明发生在调用之后（页面真实写法）
      holder.ref = ref(null);
      flushPending();
    };
    expect(run).not.toThrow();
  });

  it('setup 阶段（flush 前）绝不对 getter 求值', () => {
    pendingCbs = [];
    let evaluated = 0;
    const detail = ref<{ title: string } | null>(null);

    useBreadcrumbLabel(() => {
      evaluated++;
      return detail.value?.title;
    });

    // 关键断言：setup 期间 getter 一次都不应被调用。
    // 若有人改回立即执行的 watchEffect，这里会是 1 → 红灯。
    expect(evaluated).toBe(0);

    flushPending();
    expect(evaluated).toBeGreaterThan(0);
  });

  it('flush 后能读到真实标题（功能未被延迟破坏）', async () => {
    pendingCbs = [];
    const detail = ref<{ title: string } | null>(null);
    const seen: string[] = [];
    useBreadcrumbLabel(() => {
      seen.push(detail.value?.title ?? '');
      return detail.value?.title;
    });

    detail.value = { title: '公告标题' };
    flushPending();
    await nextTick();
    expect(seen).toContain('公告标题');
  });
});
