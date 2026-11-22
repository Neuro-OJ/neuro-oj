import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import AdminAccountDialogs from '~/components/admin/AdminAccountDialogs.vue';

const post = vi.fn();
const get = vi.fn();
const credential = {
  id: 'student-id',
  username: 'student01',
  email: 'student@users.noj.invalid',
  password: 'OneTime-2026-Ab1',
};

beforeEach(() => {
  post.mockReset();
  get.mockReset().mockResolvedValue({ data: [{ id: 'user', name: 'user' }] });
  for (const [key, value] of Object.entries({ computed, nextTick, reactive, ref, watch })) vi.stubGlobal(key, value);
  vi.stubGlobal('useApi', () => ({ api: { post, get } }));
});

const global = {
  stubs: {
    UModal: { props: ['open'], template: '<section v-if="open"><slot name="body" /></section>' },
    UForm: { template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>' },
    UFormField: { template: '<label><slot /></label>' },
    UButton: { template: '<button><slot /></button>' },
    UInput: {
      props: ['modelValue'],
      template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    },
    UTextarea: {
      props: ['modelValue'],
      template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    },
    USelect: true,
  },
};

describe('AdminAccountDialogs', () => {
  it('创建后只在结果弹窗展示密码，关闭后清空，重新开号不保留旧密码', async () => {
    post.mockResolvedValue({ data: credential });
    const wrapper = mount(AdminAccountDialogs, { props: { resetUser: null }, global });
    await wrapper.findAll('button')[0]!.trigger('click');
    await flushPromises();
    await wrapper.find('input').setValue('student01');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(post.mock.calls[0]![1]).toMatchObject({ username: 'student01' });
    expect(wrapper.text()).toContain(credential.password);
    expect(wrapper.text()).toContain('关闭后无法再次查看');
    expect(wrapper.emitted('changed')).toHaveLength(1);
    const close = wrapper.findAll('button').find((button) => button.text() === '已保存，关闭')!;
    await close.trigger('click');
    expect(wrapper.text()).not.toContain(credential.password);
    await wrapper.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain(credential.password);
    expect(wrapper.findAll('input').at(-1)!.element.value).toBe('');
    wrapper.unmount();
  });

  it('导入失败显示后端逐行错误并保留输入，不展示凭据', async () => {
    post.mockRejectedValue({
      data: { error: '账号校验失败，整批未写入', errors: [{ row: 2, reason: '用户名已存在' }] },
    });
    const wrapper = mount(AdminAccountDialogs, { props: { resetUser: null }, global });
    await wrapper.findAll('button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.find('textarea').setValue('username,email,password\nstudent01,,\nstudent02,,');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('第 2 行：用户名已存在');
    expect(wrapper.find('textarea').element.value).toContain('student02');
    expect(wrapper.emitted('changed')).toBeUndefined();
    expect(wrapper.text()).not.toContain('请保存本次初始密码');
    wrapper.unmount();
  });

  it('行操作打开重置弹窗，以用户 ID 调用接口并一次性展示密码', async () => {
    post.mockResolvedValue({ data: credential });
    const wrapper = mount(AdminAccountDialogs, { props: { resetUser: null }, global });
    await wrapper.setProps({ resetUser: { id: credential.id, username: credential.username } });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(post.mock.calls[0]![0]).toBe('/api/v1/admin/identity/users/student-id/reset-password');
    expect(wrapper.text()).toContain(credential.password);
    expect(wrapper.emitted('reset-closed')).toHaveLength(1);
    wrapper.unmount();
  });
});
