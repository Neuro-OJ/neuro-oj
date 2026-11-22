import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, defineComponent, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch } from 'vue';
import ResizableSplitter from '~/components/base/ResizableSplitter.vue';
import PaginationNav from '~/components/base/PaginationNav.vue';
import AnimatedCounter from '~/components/base/AnimatedCounter.vue';
import DomainCommandPalette from '~/components/search/DomainCommandPalette.vue';

describe('细节动效与交互 ERGONOMICS 修复验证', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries({ computed, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch })) {
      vi.stubGlobal(k, v);
    }
  });

  it('ResizableSplitter 在拖拽结束与双击重置时触发 drag-end 持久化宽度', async () => {
    const wrapper = mount(ResizableSplitter, {
      props: { modelValue: 320, min: 240, max: 480, side: 'right' },
    });
    await wrapper.find('[role="separator"]').trigger('mousedown', { clientX: 300 });
    globalThis.dispatchEvent(new MouseEvent('mousemove', { clientX: 360 }));
    globalThis.dispatchEvent(new MouseEvent('mouseup'));
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([380]);
    expect(wrapper.emitted('drag-end')?.[0]).toEqual([380]);

    await wrapper.find('[role="separator"]').trigger('dblclick');
    expect(wrapper.emitted('drag-end')?.[1]).toEqual([360]);
    wrapper.unmount();
  });

  it('PaginationNav 仅在页面已向下滚动超过阈值时回顶，短页不抖动', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(globalThis, 'scrollTo', { value: scrollTo, configurable: true });
    Object.defineProperty(globalThis, 'matchMedia', {
      value: () => ({ matches: false }),
      configurable: true,
    });

    const UPaginationStub = defineComponent({
      emits: ['update:page'],
      template: '<button class="next" @click="$emit(\'update:page\', 2)">2</button>',
    });

    const view = mount(PaginationNav, {
      props: { currentPage: 1, totalPages: 3 },
      global: { stubs: { UPagination: UPaginationStub } },
    });

    Object.defineProperty(globalThis, 'scrollY', { value: 50, configurable: true });
    await view.find('.next').trigger('click');
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, 'scrollY', { value: 420, configurable: true });
    await view.find('.next').trigger('click');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    view.unmount();
  });

  it('AnimatedCounter 在 prefers-reduced-motion: reduce 时跳过 rAF 动画直接显示目标值', async () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      value: () => ({ matches: true }),
      configurable: true,
    });
    const view = mount(AnimatedCounter, { props: { value: 10 } });
    await view.setProps({ value: 99 });
    expect(view.text()).toBe('99');
    view.unmount();
  });

  it('DomainCommandPalette 方向键移动选中项时自动 scrollIntoView 保持可见', async () => {
    for (const [k, v] of Object.entries({ computed, ref })) vi.stubGlobal(k, v);
    const isOpen = ref(true);
    vi.stubGlobal('useDomainCommandPalette', () => ({ isOpen, close: vi.fn() }));
    vi.stubGlobal('useNavigationDomain', () => ref('school'));
    vi.stubGlobal('useOptionalWorkspace', () => ({
      domain: ref({
        slug: 'school',
        name: '学院',
        status: 'active',
        actor_id: 'u1',
        permissions: [],
        configuration: { features: { classroom: true, community: true, analytics: true } },
      }),
    }));
    vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'u1' }), isLoggedIn: ref(true) }));
    vi.stubGlobal('useDomainQuery', () => ({ search: vi.fn() }));
    vi.stubGlobal('useWorkspaceApi', () => ({ list: vi.fn(), remember: vi.fn() }));
    vi.stubGlobal('useKnowledge', () => ({ disabled: ref(true) }));
    vi.stubGlobal('useAsyncData', () => ({ data: ref({ data: [] }) }));

    const view = mount(DomainCommandPalette, {
      global: {
        stubs: {
          UModal: { template: '<div><slot name="content" /></div>' },
          UIcon: true,
        },
      },
      attachTo: document.body,
    });
    const scrollIntoView = vi.fn();
    for (const el of view.findAll('[role="option"]')) {
      Object.defineProperty(el.element, 'scrollIntoView', { value: scrollIntoView, configurable: true });
    }
    await view.find('input').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    view.unmount();
  });
});
