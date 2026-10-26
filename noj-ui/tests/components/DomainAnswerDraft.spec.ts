import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDomainAnswerDraft } from '~/composables/useDomainAnswerDraft';
import { domainAnswerKey } from '~/utils/domain-problems';
const draftKey = (actor: string, slug = 'school', version = 'v1') =>
  domainAnswerKey(actor, slug, 'problem', version, 'cc');
const write = (actor: string, code: string) =>
  localStorage.setItem(`noj:draft:${draftKey(actor)}`, JSON.stringify({ code, answers: {} }));
function answer(actorId: string, slug = 'school', version = 'v1') {
  const actor = ref(actorId), code = ref(''), answers = ref<Record<string, (string | boolean)[]>>({});
  const key = computed(() => draftKey(actor.value, slug, version)),
    guestKey = ref(draftKey('anonymous', slug, version));
  let state!: ReturnType<typeof useDomainAnswerDraft>;
  const view = mount(defineComponent({
    setup() {
      state = useDomainAnswerDraft(key, code, answers, ref(true), guestKey);
      return () => null;
    },
  }));
  return { view, actor, code, answers, state };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) {
    vi.stubGlobal(name, value);
  }
});
describe('作答草稿和登录交接', () => {
  it('游客离开后登录恢复同域同版本草稿，并认领到账号中', async () => {
    const guest = answer('anonymous');
    guest.code.value = 'int main(){return 7;}';
    await nextTick();
    guest.view.unmount();
    const loggedIn = answer('student');
    expect(loggedIn.code.value).toBe('int main(){return 7;}');
    expect(localStorage.getItem(`noj:draft:${draftKey('anonymous')}`)).toBeNull();
    expect(JSON.parse(localStorage.getItem(`noj:draft:${draftKey('student')}`)!).code).toBe('int main(){return 7;}');
    loggedIn.view.unmount();
  });
  it('已有账号草稿不被游客草稿覆盖，用户明确恢复后才替换', () => {
    write('student', 'account work');
    write('anonymous', 'guest work');
    const own = answer('student');
    expect(own.code.value).toBe('account work');
    expect(own.state.guestAvailable.value).toBe(true);
    own.state.restoreGuest();
    expect(own.code.value).toBe('guest work');
    expect(own.state.guestAvailable.value).toBe(false);
    own.view.unmount();
  });
  it('账号切换、不同域及不同版本不继承其他作答上下文', async () => {
    write('first', 'private account work');
    write('anonymous', 'school v1 guest');
    const otherDomain = answer('second', 'other');
    expect(otherDomain.code.value).toBe('');
    otherDomain.view.unmount();
    const otherVersion = answer('second', 'school', 'v2');
    expect(otherVersion.code.value).toBe('');
    otherVersion.view.unmount();
    const own = answer('first');
    own.state.restoreGuest();
    own.code.value = 'first account input';
    await nextTick();
    own.actor.value = 'second';
    await nextTick();
    expect(own.code.value).toBe('');
    own.actor.value = 'first';
    await nextTick();
    expect(own.code.value).toBe('first account input');
    own.view.unmount();
  });
  it('浏览器存储写入失败时保留编辑内容并显示失败状态', async () => {
    const own = answer('student');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(() => {
        throw new DOMException('full', 'QuotaExceededError');
      }),
      removeItem: vi.fn(),
    });
    own.code.value = 'copy this code';
    await nextTick();
    expect(own.code.value).toBe('copy this code');
    expect(own.state.state.value).toBe('error');
    own.view.unmount();
  });
});
