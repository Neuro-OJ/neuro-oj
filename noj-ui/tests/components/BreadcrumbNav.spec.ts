/**
 * BreadcrumbNav 组件测试（#512）。
 *
 * 面包屑由布局渲染，层级来自 `composables/useBreadcrumb`。这里把 Nuxt 专有 API
 * （`useBreadcrumbItems` / `useRoute`）与 `NuxtLink` / `UIcon` 替换为最小桩件，
 * 直接对渲染结果断言——重点验证三件事：
 *
 * 1. 未注册路径**不渲染**（admin/auth 页零影响，是「Phase 1 可独立合并」的前提）；
 * 2. 末层不可点击且带 `aria-current="page"`，非末层均可点击；
 * 3. 单层（如「题库」）不渲染，避免无回跳价值的层级占据首屏。
 */
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import BreadcrumbNav from '~/components/layout/BreadcrumbNav.vue';
import type { BreadcrumbItem } from '~/utils/breadcrumb';

/** 每个用例通过它控制层级（模拟不同路由）。 */
let resolved: BreadcrumbItem[] = [];

/** NuxtLink 桩件：渲染为 <a>，便于断言 href。 */
const NuxtLinkStub = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], default: undefined } },
  setup(props, { slots }) {
    return () => h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default?.());
  },
});

/** UIcon 桩件：分隔符图标带 aria-hidden，测试对其计数。 */
const UIconStub = defineComponent({
  name: 'UIcon',
  props: { name: { type: String, default: '' } },
  setup(props, { attrs }) {
    return () => h('span', { class: 'icon', 'data-icon': props.name, ...attrs });
  },
});

beforeAll(() => {
  // Nuxt 自动导入（组件内未显式 import），因此必须挂到全局
  vi.stubGlobal('useBreadcrumbItems', () => computed(() => resolved));
  vi.stubGlobal('useRoute', () => ({ path: '/', meta: {} }));
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
});

function mountNav() {
  return mount(BreadcrumbNav, {
    global: { components: { NuxtLink: NuxtLinkStub, UIcon: UIconStub } },
  });
}

describe('BreadcrumbNav', () => {
  it('未匹配到层级时不渲染 nav（admin/auth 页零影响）', () => {
    resolved = [];
    const wrapper = mountNav();
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('单层时不渲染（无回跳价值）', () => {
    resolved = [{ label: '题库' }];
    const wrapper = mountNav();
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('多层时渲染完整路径，末层不可点击且带 aria-current="page"', () => {
    resolved = [
      { label: '竞赛', to: '/contests' },
      { label: '春季赛', to: '/contests/c1' },
      { label: 'A', param: 'label' },
    ];
    const wrapper = mountNav();

    const nav = wrapper.find('nav');
    expect(nav.exists()).toBe(true);
    expect(nav.attributes('aria-label')).toBe('面包屑');

    const links = wrapper.findAll('a');
    // 前两层可点击，末层不是链接
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/contests');
    expect(links[1].attributes('href')).toBe('/contests/c1');

    const current = wrapper.find('[aria-current="page"]');
    expect(current.exists()).toBe(true);
    expect(current.text()).toBe('A');
  });

  it('分隔符对辅助技术隐藏', () => {
    resolved = [{ label: '题库', to: '/problems' }, { label: 'P1' }];
    const wrapper = mountNav();
    const separators = wrapper.findAll('[aria-hidden="true"]');
    expect(separators.length).toBe(1);
  });
});
