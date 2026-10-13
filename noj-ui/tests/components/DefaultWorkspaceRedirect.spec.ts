import { beforeEach, describe, expect, it, vi } from 'vitest';
const get = vi.fn(), navigate = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('defineNuxtRouteMiddleware', (handler: unknown) => handler);
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('navigateTo', navigate);
  vi.stubGlobal(
    'createError',
    (input: { statusCode: number; statusMessage: string }) =>
      Object.assign(new Error(input.statusMessage), { statusCode: input.statusCode }),
  );
});
async function enter(path: string, query: Record<string, string> = {}) {
  const { default: redirect } = await import('~/middleware/default-workspace.global');
  return redirect({ path, query, hash: '' } as never, {} as never);
}
describe('旧业务入口的默认域兼容', () => {
  it('P号不读取账号偏好、不查询旧题库，旧题库类别从回跳参数移除', async () => {
    await enter('/problems/P1001', { type: 'U', keyword: 'A+B' });
    expect(get).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ path: '/d/main/problems/1001', query: { keyword: 'A+B' }, hash: '' }, {
      redirectCode: 301,
      replace: true,
    });
  });
  it('旧UUID仅用main兼容只读门面定位，解析失败不能跳到其他域或猜数字', async () => {
    get.mockResolvedValue({ data: { number: 1001 } });
    await enter('/editor/legacy-uuid');
    expect(get).toHaveBeenCalledWith('/api/v1/problems/legacy-uuid', { silent: true });
    expect(navigate.mock.calls[0]![0].path).toBe('/d/main/problems/1001');
    get.mockRejectedValue({ statusCode: 404 });
    navigate.mockClear();
    await expect(enter('/problems/foreign-uuid')).rejects.toMatchObject({ statusCode: 404, message: '题目不存在' });
    await expect(enter('/editor/NOEXIST')).rejects.toMatchObject({ statusCode: 404, message: '题目不存在' });
    const forbidden = { statusCode: 403, message: 'Forbidden' };
    get.mockRejectedValue(forbidden);
    await expect(enter('/editor/restricted-uuid')).rejects.toBe(forbidden);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('U题旧地址不映射同号main题；题单公开ID先授权读取稳定ID', async () => {
    await expect(enter('/problems/U1001')).rejects.toMatchObject({ statusCode: 404 });
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValue({ data: { id: 'training-uuid' } });
    await enter('/trainings/tr-old');
    expect(get).toHaveBeenCalledWith('/api/v1/trainings/tr-old', { silent: true });
    expect(navigate.mock.calls[0]![0].path).toBe('/d/main/trainings/training-uuid');
  });
  it('已经显式指定其他域的资源完全保留路径', async () => {
    await enter('/d/school/problems/main:1001');
    expect(get).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
