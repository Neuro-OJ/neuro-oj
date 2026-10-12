/**
 * 轮播幻灯片 composable（与公告解耦）。
 *
 * - 公开读：`GET /api/v1/carousel/slides`（仅启用项，按 sort_order）。
 * - 管理读写：`/api/v1/admin/carousel/slides`（CRUD + reorder + 图片上传）。
 */

import { ref } from 'vue';

/** 幻灯片类型。 */
export type CarouselKind = 'image' | 'text';

/** 幻灯片结构。 */
export interface CarouselSlide {
  id: string;
  kind: CarouselKind;
  image_storage_url: string | null;
  title: string | null;
  subtitle: string | null;
  gradient_key: string | null;
  link_url: string | null;
  sort_order: number;
  is_enabled: boolean;
}

/** 新建/更新入参。 */
export interface CarouselSlideInput {
  kind: CarouselKind;
  image_storage_url?: string | null;
  title?: string | null;
  subtitle?: string | null;
  gradient_key?: string | null;
  link_url?: string | null;
  is_enabled?: boolean;
}

/**
 * 轮播能力。
 */
export function useCarousel() {
  const { api } = useApi();
  const slides = ref<CarouselSlide[]>([]);

  /** 公开端：加载启用中的 slides。 */
  async function loadEnabled(silent = true): Promise<CarouselSlide[]> {
    const res = await api.get<{ data: CarouselSlide[] }>(
      '/api/v1/carousel/slides',
      { silent },
    );
    slides.value = res.data;
    return res.data;
  }

  /** 管理端：加载全部（含停用）。 */
  async function loadAll(silent = true): Promise<CarouselSlide[]> {
    const res = await api.get<{ data: CarouselSlide[] }>(
      '/api/v1/admin/carousel/slides',
      { silent },
    );
    return res.data;
  }

  /** 新建。 */
  async function create(input: CarouselSlideInput): Promise<string> {
    const res = await api.post<{ data: { id: string } }>(
      '/api/v1/admin/carousel/slides',
      input,
    );
    return res.data.id;
  }

  /** 更新（部分更新）。 */
  async function update(id: string, input: Partial<CarouselSlideInput>): Promise<void> {
    await api.patch(`/api/v1/admin/carousel/slides/${id}`, input);
  }

  /** 删除。 */
  async function remove(id: string): Promise<void> {
    await api.delete(`/api/v1/admin/carousel/slides/${id}`);
  }

  /** 按 id 顺序重排。 */
  async function reorder(ids: string[]): Promise<void> {
    await api.post('/api/v1/admin/carousel/slides/reorder', { ids }, { silent: true });
  }

  /** 上传图片，返回存储 URL。 */
  async function uploadImage(file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file);
    const res = await api.post<{ data: { image_storage_url: string } }>(
      '/api/v1/admin/carousel/images',
      form,
    );
    return res.data.image_storage_url;
  }

  return { slides, loadEnabled, loadAll, create, update, remove, reorder, uploadImage };
}
