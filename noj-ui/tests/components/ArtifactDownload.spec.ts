import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import ArtifactDownload from '~/components/submission/ArtifactDownload.vue';
const get = vi.fn(), click = vi.fn(), create = vi.fn(), revoke = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create.mockReturnValue('blob:artifact') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
});
function view() {
  return mount(ArtifactDownload, {
    props: {
      endpoint: '/api/v1/domains/school/classrooms/c1/submissions/submission/s1/artifact',
      fileName: 'answer.zip',
    },
    global: {
      stubs: {
        UButton: { template: '<button><slot /></button>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
      },
    },
  });
}
describe('原产物授权下载', () => {
  it('通过API代理获取原始二进制，完成后释放临时URL', async () => {
    const artifact = new Blob([new Uint8Array([0, 255, 80, 75])], { type: 'application/zip' });
    get.mockResolvedValue(artifact);
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/api/v1/domains/school/classrooms/c1/submissions/submission/s1/artifact', {
      responseType: 'blob',
      silent: true,
    });
    expect(create).toHaveBeenCalledWith(artifact);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:artifact');
  });
  it('撤权或产物丢失显示服务端原因，保留原页面并允许重试', async () => {
    get.mockRejectedValue({
      statusCode: 404,
      data: new Blob([JSON.stringify({ error: '原产物不可用', code: 'ARTIFACT_UNAVAILABLE' })], {
        type: 'application/json',
      }),
    });
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    expect(result.text()).toContain('原产物不可用');
    expect(create).not.toHaveBeenCalled();
    get.mockResolvedValue(new Blob(['zip']));
    await result.get('button').trigger('click');
    await flushPromises();
    expect(result.text()).not.toContain('原产物不可用');
    expect(click).toHaveBeenCalledOnce();
  });
});
