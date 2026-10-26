import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { useEducationNotifications } from '~/composables/useEducationNotifications';
class Source {
  static instances: Source[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, (event: { data: string }) => void> = {};
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  addEventListener(name: string, callback: (event: { data: string }) => void) {
    this.listeners[name] = callback;
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.listeners[name]?.({ data: JSON.stringify(data) });
  }
}
const slug = ref('school'), domain = ref({ is_member: true, platform_admin: false }), user = ref({ id: 'student' });
beforeEach(() => {
  vi.useFakeTimers();
  Source.instances = [];
  slug.value = 'school';
  user.value = { id: 'student' };
  domain.value = { is_member: true, platform_admin: false };
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal('useWorkspace', () => ({ slug, domain }));
  vi.stubGlobal('useAuth', () => ({ user }));
});
describe('教学通知只以SSE触发授权重读', () => {
  it('非教学首页不建立教学连接，启用视角后连接并在关闭时清理', async () => {
    const enabled = ref(false), refresh = vi.fn().mockResolvedValue(undefined);
    const view = mount(defineComponent({
      setup() {
        useEducationNotifications(refresh, enabled);
        return () => null;
      },
    }));
    expect(Source.instances).toHaveLength(0);
    enabled.value = true;
    await nextTick();
    expect(Source.instances).toHaveLength(1);
    enabled.value = false;
    await nextTick();
    expect(Source.instances[0]!.closed).toBe(true);
    view.unmount();
    vi.useRealTimers();
  });
  it('同步和通知都重新读REST，切换账号和域关闭旧连接且不沿用序号', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const component = defineComponent({
      setup: () => {
        useEducationNotifications(refresh);
        return () => null;
      },
    });
    const view = mount(component), first = Source.instances[0]!;
    expect(first.url).toBe('/api/v1/domains/school/notifications/events');
    first.emit('education:sync', { domain_id: 'school-id' });
    first.emit('education:notification', { notification_id: 'notice', seq: 7, score: 10000, body: '不可信载荷' });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith();
    user.value = { id: 'teacher' };
    await nextTick();
    expect(first.closed).toBe(true);
    expect(Source.instances[1]!.url).toBe('/api/v1/domains/school/notifications/events');
    slug.value = 'second-school';
    await nextTick();
    expect(Source.instances[1]!.closed).toBe(true);
    expect(Source.instances[2]!.url).toBe('/api/v1/domains/second-school/notifications/events');
    view.unmount();
    expect(Source.instances[2]!.closed).toBe(true);
    vi.useRealTimers();
  });
  it('断线轮询并重连，成员失权后停止推送和轮询', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const component = defineComponent({
      setup: () => {
        useEducationNotifications(refresh);
        return () => null;
      },
    });
    const view = mount(component), first = Source.instances[0]!;
    first.onopen!();
    first.onerror!();
    expect(first.closed).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Source.instances).toHaveLength(2);
    domain.value = { is_member: false, platform_admin: false };
    await nextTick();
    const count = refresh.mock.calls.length;
    expect(Source.instances[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(count);
    view.unmount();
    vi.useRealTimers();
  });
});
