import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import Selector from '~/components/feature/DomainProblemVersionSelect.vue';

beforeEach(() => {
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainProblems', () => ({ versions: vi.fn() }));
  vi.stubGlobal('useAsyncData', () =>
    Promise.resolve({
      data: ref({ items: [{ version_id: 'v2', version: 2 }, { version_id: 'v1', version: 1 }], total: 2, limit: 20 }),
      status: ref('success'),
      error: ref(null),
      refresh: vi.fn(),
    }));
});

describe('题面旁的作答版本选择器', () => {
  it('标明当前版本及成绩认可状态，并允许选择不计分的历史版本', async () => {
    const selected = vi.fn();
    const wrapper = mount(
      defineComponent({
        setup: () => () =>
          h(Suspense, null, {
            default: () =>
              h(Selector, {
                slug: 'school',
                reference: 'main:1001',
                selected: 'v2',
                version: 2,
                current: 'v2',
                mode: 'exact',
                required: 'v2',
                onSelect: selected,
              }),
          }),
      }),
      {
        global: {
          stubs: {
            UPopover: { template: '<div><slot /><slot name="content" /></div>' },
            UButton: { template: '<button><slot /></button>' },
            UIcon: true,
          },
        },
      },
    );
    await flushPromises();
    const options = wrapper.findAll('[role="option"]');
    expect(options[0].text()).toBe('v2（当前版本）');
    expect(options[0].classes()).toContain('text-success-text');
    expect(options[1].classes()).toContain('text-text-muted');
    expect(options[0].attributes('aria-selected')).toBe('true');
    await options[1].trigger('click');
    expect(selected).toHaveBeenCalledWith('v1');
    wrapper.unmount();
  });
});
