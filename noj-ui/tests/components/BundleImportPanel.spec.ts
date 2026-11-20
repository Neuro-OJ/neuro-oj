import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import ZipDropZone from '~/components/shared/ZipDropZone.vue';
import BundleImportPanel from '~/components/editor/BundleImportPanel.vue';

const post = vi.fn();
const toastSuccess = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { success: toastSuccess, error: vi.fn() } }),
}));

beforeAll(() => {
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useApi', () => ({ api: { post } }));
});

beforeEach(() => {
  post.mockReset();
  toastSuccess.mockReset();
});

const global = { components: { ZipDropZone }, stubs: { UIcon: true } };
const props = { domainSlug: 'school-a' };

function dropFile(wrapper: ReturnType<typeof mount>, name: string) {
  const file = new File(['PK'], name, { type: 'application/zip' });
  return wrapper.find('[data-testid="zip-drop-zone"]').trigger('drop', {
    dataTransfer: { files: [file] },
  });
}

describe('ZipDropZone', () => {
  it('拖入 zip 时抛出 file 事件', async () => {
    const wrapper = mount(ZipDropZone, { global });
    await dropFile(wrapper, 'p.zip');
    expect(wrapper.emitted('file')?.[0]?.[0]).toBeInstanceOf(File);
  });

  it('非 zip 文件就地提示，不抛出事件', async () => {
    const wrapper = mount(ZipDropZone, { global });
    await dropFile(wrapper, 'p.tar.gz');
    expect(wrapper.emitted('file')).toBeUndefined();
    expect(wrapper.text()).toContain('仅支持 .zip 格式文件');
  });

  it('禁用 / 处理中时拖拽投放不生效（不能绕过 disabled）', async () => {
    for (const props of [{ disabled: true }, { busy: true }]) {
      const wrapper = mount(ZipDropZone, { props, global });
      await dropFile(wrapper, 'p.zip');
      expect(wrapper.emitted('file')).toBeUndefined();
    }
  });
});

describe('BundleImportPanel', () => {
  it('不带 problem_id 走建题路径；成功后提示并抛出 imported', async () => {
    post.mockResolvedValue({ data: { problem_id: 'uuid-1', number: 1001, draft_revision: 3, published: null } });
    const wrapper = mount(BundleImportPanel, { props, global });
    await dropFile(wrapper, 'p.zip');
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('/api/v1/domains/school-a/problems/import-bundle');
    const form = body as FormData;
    expect(form.get('file')).toBeInstanceOf(File);
    expect(form.has('problem_id')).toBe(false);
    expect(form.has('publish')).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith('已导入 1001（草稿：核对后发布即可作答）');
    expect(wrapper.emitted('imported')?.[0]?.[0]).toMatchObject({ problem_id: 'uuid-1' });
  });

  it('勾选发布时使用该域题号与导入草稿 revision', async () => {
    post.mockResolvedValueOnce({ data: { problem_id: 'uuid-1', number: 1001, draft_revision: 3 } });
    post.mockResolvedValueOnce({ version: 1 });
    const wrapper = mount(BundleImportPanel, { props, global });
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await dropFile(wrapper, 'p.zip');
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual([
      '/api/v1/domains/school-a/problems/1001/publish',
      { change_note: '题目包导入' },
      { headers: { 'If-Match': '3' } },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith('已导入 1001 并发布 V1');
  });

  it('题号撞到已有题目（428）时给出可操作的提示，不跳转', async () => {
    post.mockRejectedValue({
      status: 428,
      data: { error: '保存草稿必须携带 If-Match', code: 'DRAFT_REVISION_REQUIRED' },
    });
    const wrapper = mount(BundleImportPanel, { props, global });
    await dropFile(wrapper, 'p.zip');
    await flushPromises();

    expect(wrapper.emitted('imported')).toBeUndefined();
    expect(wrapper.text()).toContain('number 与已有题目重复');
  });
});
