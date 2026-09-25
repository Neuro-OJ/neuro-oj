<script setup lang="ts">
// 轮播管理页（与公告解耦，2026-09-24）。
//
// 列表 + 新建/编辑（image/text 切换）+ 上移/下移排序 + 启停 + 图片上传。
// 权限：`announcement:manage`（与公告管理复用同一运营展示位权限）。

import { extractApiError } from "~/utils/apiError";
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from "~/composables/useToast";
import type { CarouselSlide, CarouselSlideInput, CarouselKind } from "~/composables/useCarousel";
import { CAROUSEL_GRADIENTS } from "~/utils/carouselGradient";

definePageMeta({ layout: "admin", middleware: "admin", ssr: false });

const { api } = useApi();
const { toast } = useToast();
const { loadAll, create, update, remove, reorder, uploadImage } = useCarousel();

const items = ref<CarouselSlide[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = await loadAll(true);
  } catch (err: unknown) {
    error.value = extractApiError(err).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ── 表单 ──
const showForm = ref(false);
const editing = ref<CarouselSlide | null>(null);
const saving = ref(false);
const formError = ref("");
const formKind = ref<CarouselKind>("text");
const formTitle = ref("");
const formSubtitle = ref("");
const formGradient = ref("blue");
const formLinkUrl = ref("");
const formImageUrl = ref("");
const formEnabled = ref(true);
const uploading = ref(false);

const GRADIENT_ITEMS = Object.keys(CAROUSEL_GRADIENTS).map((k) => ({ label: k, value: k }));

function openCreate() {
  editing.value = null;
  formKind.value = "text";
  formTitle.value = "";
  formSubtitle.value = "";
  formGradient.value = "blue";
  formLinkUrl.value = "";
  formImageUrl.value = "";
  formEnabled.value = true;
  formError.value = "";
  showForm.value = true;
}

function openEdit(row: CarouselSlide) {
  editing.value = row;
  formKind.value = row.kind;
  formTitle.value = row.title ?? "";
  formSubtitle.value = row.subtitle ?? "";
  formGradient.value = row.gradient_key ?? "blue";
  formLinkUrl.value = row.link_url ?? "";
  formImageUrl.value = row.image_storage_url ?? "";
  formEnabled.value = row.is_enabled;
  formError.value = "";
  showForm.value = true;
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  formError.value = "";
  try {
    formImageUrl.value = await uploadImage(file);
    toast.success("图片已上传");
  } catch (err: unknown) {
    formError.value = extractApiError(err).message;
  } finally {
    uploading.value = false;
    input.value = "";
  }
}

async function handleSave() {
  saving.value = true;
  formError.value = "";
  const payload: CarouselSlideInput = {
    kind: formKind.value,
    title: formKind.value === "text" ? formTitle.value.trim() : (formTitle.value.trim() || null),
    subtitle: formSubtitle.value.trim() || null,
    gradient_key: formKind.value === "text" ? formGradient.value : null,
    link_url: formLinkUrl.value.trim() || null,
    image_storage_url: formKind.value === "image" ? formImageUrl.value : null,
    is_enabled: formEnabled.value,
  };
  try {
    if (editing.value) await update(editing.value.id, payload);
    else await create(payload);
    showForm.value = false;
    await load();
  } catch (err: unknown) {
    formError.value = extractApiError(err).message;
  } finally {
    saving.value = false;
  }
}

// ── 启停 / 删除 / 排序 ──
const busyId = ref("");

async function toggleEnabled(row: CarouselSlide) {
  busyId.value = row.id;
  try {
    await update(row.id, { is_enabled: !row.is_enabled });
    await load();
  } catch (err: unknown) {
    toast.error(extractApiError(err).message);
  } finally {
    busyId.value = "";
  }
}

async function handleDelete(row: CarouselSlide) {
  busyId.value = row.id;
  try {
    await remove(row.id);
    toast.success("已删除");
    await load();
  } catch (err: unknown) {
    toast.error(extractApiError(err).message);
  } finally {
    busyId.value = "";
  }
}

async function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= items.value.length) return;
  const ids = items.value.map((s) => s.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  try {
    await reorder(ids);
    await load();
  } catch (err: unknown) {
    toast.error(extractApiError(err).message);
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader title="轮播管理" description="配置首页轮播幻灯片（与公告解耦）；未启用或排序在后的按序展示">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新建幻灯片
        </UButton>
      </template>
    </AdminPageHeader>

    <AsyncContent :status="loading ? 'loading' : error ? 'error' : items.length === 0 ? 'empty' : 'data'" :error="error">
      <div class="rounded-lg border border-border overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-bg-sunken text-text-secondary">
            <tr>
              <th class="text-left px-3 py-2">排序</th>
              <th class="text-left px-3 py-2">类型</th>
              <th class="text-left px-3 py-2">内容</th>
              <th class="text-left px-3 py-2">跳转</th>
              <th class="text-left px-3 py-2">状态</th>
              <th class="text-left px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in items" :key="s.id" class="border-t border-border align-middle">
              <td class="px-3 py-2">
                <div class="flex items-center gap-1">
                  <span class="tabular-nums text-text-muted w-6">{{ i + 1 }}</span>
                  <UButton size="xs" color="neutral" variant="ghost" :disabled="i === 0" aria-label="上移" @click="move(i, -1)">
                    <UIcon name="i-lucide-arrow-up" class="size-3.5" />
                  </UButton>
                  <UButton size="xs" color="neutral" variant="ghost" :disabled="i === items.length - 1" aria-label="下移" @click="move(i, 1)">
                    <UIcon name="i-lucide-arrow-down" class="size-3.5" />
                  </UButton>
                </div>
              </td>
              <td class="px-3 py-2">{{ s.kind === "image" ? "图片" : "文案" }}</td>
              <td class="px-3 py-2 max-w-xs">
                <span class="font-medium">{{ s.title || "—" }}</span>
                <span v-if="s.subtitle" class="ml-1 text-text-muted">{{ s.subtitle }}</span>
              </td>
              <td class="px-3 py-2 max-w-xs truncate text-text-muted">{{ s.link_url || "不可点" }}</td>
              <td class="px-3 py-2">{{ s.is_enabled ? "已启用" : "已停用" }}</td>
              <td class="px-3 py-2">
                <div class="flex gap-1.5">
                  <UButton size="xs" color="neutral" variant="outline" :loading="busyId === s.id" @click="toggleEnabled(s)">
                    {{ s.is_enabled ? "停用" : "启用" }}
                  </UButton>
                  <UButton size="xs" color="neutral" variant="outline" @click="openEdit(s)">编辑</UButton>
                  <UButton size="xs" color="error" variant="outline" :loading="busyId === s.id" @click="handleDelete(s)">删除</UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncContent>

    <!-- 新建/编辑弹窗 -->
    <UModal v-model:open="showForm" :title="editing ? '编辑幻灯片' : '新建幻灯片'">
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-13px font-semibold text-text">类型</label>
            <USelect
              v-model="formKind"
              :items="[{ label: '文案（渐变）', value: 'text' }, { label: '图片', value: 'image' }]"
            />
          </div>

          <template v-if="formKind === 'image'">
            <div class="flex flex-col gap-1">
              <label class="text-13px font-semibold text-text">图片 <span class="text-error-text">*</span></label>
              <input type="file" accept="image/png,image/jpeg,image/webp" class="text-sm" @change="handleUpload" />
              <p v-if="uploading" class="text-12px text-text-muted">上传中…</p>
              <p v-else-if="formImageUrl" class="text-12px text-success-text">已上传</p>
            </div>
          </template>

          <template v-else>
            <div class="flex flex-col gap-1">
              <label class="text-13px font-semibold text-text">标题 <span class="text-error-text">*</span></label>
              <UInput v-model="formTitle" maxlength="100" placeholder="幻灯片标题" />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-13px font-semibold text-text">渐变</label>
              <USelect v-model="formGradient" :items="GRADIENT_ITEMS" />
            </div>
          </template>

          <div class="flex flex-col gap-1">
            <label class="text-13px font-semibold text-text">副标题</label>
            <UInput v-model="formSubtitle" maxlength="200" placeholder="可选" />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-13px font-semibold text-text">跳转地址</label>
            <UInput v-model="formLinkUrl" placeholder="留空则整卡不可点（支持 / 站内路径或 http(s)）" />
          </div>
          <div class="flex items-center justify-between gap-4">
            <label class="text-13px font-semibold text-text cursor-pointer select-none" for="car-form-enabled">启用</label>
            <USwitch v-model="formEnabled" id="car-form-enabled" />
          </div>
          <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="saving" @click="showForm = false">取消</UButton>
        <UButton color="primary" :loading="saving" @click="handleSave">保存</UButton>
      </template>
    </UModal>
  </div>
</template>
