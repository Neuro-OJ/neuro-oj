import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { useUnsavedChanges } from '~/composables/useUnsavedChanges';
const confirm = vi.fn(), leave = vi.fn(), update = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('onBeforeRouteLeave', leave);
  vi.stubGlobal('onBeforeRouteUpdate', update);
});
function form() {
  const dirty = ref(false);
  const view = mount(defineComponent({
    setup() {
      useUnsavedChanges(dirty);
      return () => null;
    },
  }));
  return { view, dirty };
}
describe('未保存输入保护', () => {
  it('干净表单直接离开，修改后取消保留页面，保存后不再询问', async () => {
    const { view, dirty } = form(), guard = leave.mock.calls[0]![0];
    expect(await guard()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    dirty.value = true;
    confirm.mockResolvedValueOnce(false);
    expect(await guard()).toBe(false);
    confirm.mockResolvedValueOnce(true);
    expect(await update.mock.calls[0]![0]()).toBe(true);
    confirm.mockClear();
    dirty.value = false;
    expect(await guard()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    view.unmount();
  });
  it('刷新保护只在未保存时生效，卸载后清理监听器', () => {
    const { view, dirty } = form();
    const dispatch = () => {
      const event = new Event('beforeunload', { cancelable: true });
      globalThis.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(dispatch()).toBe(false);
    dirty.value = true;
    expect(dispatch()).toBe(true);
    view.unmount();
    expect(dispatch()).toBe(false);
  });
});
