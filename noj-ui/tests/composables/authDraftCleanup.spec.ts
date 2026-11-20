import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuth } from '~/composables/useAuth';
import { useDomainAnswerDraft } from '~/composables/useDomainAnswerDraft';
import type { AuthUser } from '~/utils/auth-user';
import { domainAnswerKey } from '~/utils/domain-problems';

const student: AuthUser = {
  id: 'first',
  username: 'first',
  email: '',
  role: 'student',
  is_admin: false,
  must_change_password: false,
  email_verified: true,
  has_local_password: true,
  created_at: '',
  updated_at: '',
};
const user = ref<AuthUser | null>(student);
const session = ref<{ userId: string; username: string } | null>(null);
const api = { post: vi.fn(), get: vi.fn() };
const key = (actor: string) => `noj:draft:${domainAnswerKey(actor, 'school', 'p', 'v1', 'cc')}`;
const views: VueWrapper[] = [];

function setup(withDraft = false) {
  let auth!: ReturnType<typeof useAuth>;
  const code = ref(''), answers = ref<Record<string, (string | boolean)[]>>({});
  const view = mount(defineComponent({
    setup() {
      auth = useAuth();
      if (withDraft) {
        useDomainAnswerDraft(
          computed(() => domainAnswerKey(auth.user.value?.id ?? 'anonymous', 'school', 'p', 'v1', 'cc')),
          code,
          answers,
          ref(true),
          ref(domainAnswerKey('anonymous', 'school', 'p', 'v1', 'cc')),
        );
      }
      return () => null;
    },
  }));
  views.push(view);
  return { auth, code, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  user.value = { ...student };
  session.value = { userId: student.id, username: student.username };
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { authCookiePrefix: 'noj' } }));
  vi.stubGlobal('useState', (name: string) => name === 'auth:user' ? user : ref(false));
  vi.stubGlobal('useCookie', () => session);
  vi.stubGlobal('useApi', () => ({ api }));
  api.post.mockResolvedValue({ data: { user: { ...student, id: 'second' } } });
  localStorage.setItem(key('first'), JSON.stringify({ code: 'first work', answers: {} }));
  localStorage.setItem(key('second'), JSON.stringify({ code: 'second work', answers: {} }));
  localStorage.setItem(key('anonymous'), JSON.stringify({ code: 'guest work', answers: {} }));
  localStorage.setItem('noj:draft:old-problem', 'legacy work');
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.unstubAllGlobals();
});

describe('认证退出与草稿清理', () => {
  it.each([false, true])('主动登出（请求失败：%s）清理账号和旧键，保留游客与其他账号', async (failed) => {
    const { auth } = setup();
    if (failed) api.post.mockRejectedValueOnce(new Error('offline'));
    await auth.logout();
    expect(user.value).toBeNull();
    expect(session.value).toBeNull();
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(localStorage.getItem('noj:draft:old-problem')).toBeNull();
    expect(localStorage.getItem(key('anonymous'))).toContain('guest work');
    expect(localStorage.getItem(key('second'))).toContain('second work');
  });
  it('编辑器未卸载时登出再登录，旧输入不会写回或污染下一账号', async () => {
    const { auth, code, view } = setup(true);
    code.value = 'pending private edit';
    await auth.logout();
    await auth.login('second', 'password');
    await nextTick();
    expect(code.value).toBe('second work');
    view.unmount();
    views.splice(views.indexOf(view), 1);
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(localStorage.getItem(key('second'))).not.toContain('private');
    expect(localStorage.getItem(key('anonymous'))).toContain('guest work');
  });
  it('会话验证的 401 清理草稿，网络错误保留草稿和会话', async () => {
    const { auth } = setup();
    api.get.mockRejectedValueOnce({ status: 503 });
    await auth.fetchUser();
    expect(localStorage.getItem(key('first'))).toContain('first work');
    expect(user.value?.id).toBe('first');
    api.get.mockRejectedValueOnce({ status: 401 });
    await auth.fetchUser();
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(localStorage.getItem('noj:draft:old-problem')).toBeNull();
    expect(user.value).toBeNull();
  });
  it('尚未恢复 user 的认证守卫收到 401，仍按 session 中的账号清理', async () => {
    const { auth } = setup();
    user.value = null;
    localStorage.setItem(key('first'), 'restored account work');
    api.get.mockRejectedValueOnce({ status: 401 });
    await auth.ensureAuthReady();
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(session.value).toBeNull();
  });
  it('可读会话被清除时清理用户草稿和本地登录态', () => {
    setup();
    session.value = null;
    expect(user.value).toBeNull();
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(localStorage.getItem('noj:draft:old-problem')).toBeNull();
    expect(localStorage.getItem(key('anonymous'))).toContain('guest work');
  });
  it('直接登录其他账号也清理前一账号草稿', async () => {
    const { auth } = setup();
    await auth.login('second', 'password');
    expect(user.value?.id).toBe('second');
    expect(localStorage.getItem(key('first'))).toBeNull();
    expect(localStorage.getItem(key('second'))).toContain('second work');
  });
});
