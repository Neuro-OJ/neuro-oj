import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDraftStorage } from '~/composables/useDraftStorage';
import { domainAnswerKey } from '~/utils/domain-problems';
import { clearUserDrafts, draftActor } from '~/utils/draft-storage';

const target = (actor: string, context = 'problem') => domainAnswerKey(actor, 'global', context, '', 'answer');
const storageKey = (actor: string, context = 'problem') => `noj:draft:${target(actor, context)}`;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) {
    vi.stubGlobal(name, value);
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('旧编辑器与界面工作区的账号草稿', () => {
  it.each(['problem', 'contest:contest-id:A'])('同一题目上下文 %s 的两个账号互不可见', async (context) => {
    const actor = ref('first');
    const key = computed(() => target(actor.value, context));
    const code = ref('');
    const view = mount(defineComponent({
      setup() {
        useDraftStorage(key, code, ref(true));
        return () => null;
      },
    }));
    expect(draftActor(key.value)).toBe('first');
    code.value = 'private code or UI parameters';
    await nextTick();
    await vi.advanceTimersByTimeAsync(799);
    expect(localStorage.getItem(storageKey('first', context))).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(localStorage.getItem(storageKey('first', context))).toContain('private');
    code.value = 'pending private code';
    await nextTick();
    clearUserDrafts('first');
    actor.value = 'second';
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(code.value).toBe('');
    expect(localStorage.getItem(storageKey('first', context))).toBeNull();
    expect(localStorage.getItem(storageKey('second', context)) ?? '').not.toContain('private');
    actor.value = 'anonymous';
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(code.value).toBe('');
    view.unmount();
  });
  it('只读取当前账号的存量草稿，忽略无账号归属的旧键', () => {
    localStorage.setItem('noj:draft:problem', JSON.stringify({ content: 'legacy private', updatedAt: 1 }));
    localStorage.setItem(storageKey('first'), JSON.stringify({ content: 'first private', updatedAt: 1 }));
    localStorage.setItem(storageKey('second'), JSON.stringify({ content: 'second work', updatedAt: 2 }));
    const code = ref('');
    const view = mount(defineComponent({
      setup() {
        useDraftStorage(ref(target('second')), code, ref(true));
        return () => null;
      },
    }));
    expect(code.value).toBe('second work');
    view.unmount();
  });
});

describe('草稿归属与清理', () => {
  it('删除当前账号全部上下文和旧格式键，保留其他账号、游客及其他存储', () => {
    const removed = [
      storageKey('first'),
      storageKey('first', 'contest:c:A'),
      `noj:draft:${domainAnswerKey('first', 'school', 'p', 'v1', 'cc')}`,
      'noj:draft:problem',
      'noj:draft:contest:c:A',
      'noj:draft:school:contest:c:p:v1',
      'noj:draft:school:contest:c:p:v1:ui',
      'noj:draft:school:contest:c:p:v1:questions',
      'noj:draft:school:guest:p:v1',
      'noj:draft:["domain-answer"]',
    ];
    const retained = [storageKey('second'), storageKey('anonymous'), 'noj:editor:theme', 'other:noj:draft:p'];
    for (const key of [...removed, ...retained]) localStorage.setItem(key, 'keep or remove');
    clearUserDrafts('first');
    for (const key of removed) expect(localStorage.getItem(key)).toBeNull();
    for (const key of retained) expect(localStorage.getItem(key)).toBe('keep or remove');
  });
  it('未知账号或游客退出时只删无归属旧键', () => {
    for (const actor of [undefined, 'anonymous']) {
      localStorage.setItem(storageKey('anonymous'), 'guest');
      localStorage.setItem(storageKey('first'), 'account');
      localStorage.setItem('noj:draft:old', 'legacy');
      clearUserDrafts(actor);
      expect(localStorage.getItem('noj:draft:old')).toBeNull();
      expect(localStorage.getItem(storageKey('anonymous'))).toBe('guest');
      expect(localStorage.getItem(storageKey('first'))).toBe('account');
    }
  });
  it('禁用 localStorage 时清理不抛错', () => {
    vi.stubGlobal('localStorage', {
      get length() {
        throw new Error('storage disabled');
      },
    });
    expect(() => clearUserDrafts('first')).not.toThrow();
  });
});
