<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { WORKSPACE_LIMIT_FIELDS } from '~/utils/instance-governance';
import type { WorkspaceLimits } from '~/utils/workspace';
import {
  bestStorageUnit,
  bytesToUnitValue,
  canLosslesslyConvert,
  GIB,
  MIB,
  STORAGE_PRESET_GIB,
  STORAGE_UNIT_OPTIONS,
  type StorageUnit,
  validateStorageInput,
} from '~/utils/storage-limit';

export type LimitMode = 'domain_limits' | 'instance_caps' | 'instance_defaults';

const model = defineModel<WorkspaceLimits>({ required: true });
const props = withDefaults(
  defineProps<{
    caps?: WorkspaceLimits;
    effective?: WorkspaceLimits;
    disabled?: boolean;
    mode?: LimitMode;
  }>(),
  {
    mode: 'domain_limits',
  },
);

const emit = defineEmits<{
  (e: 'valid', isValid: boolean): void;
}>();

const isCustom = reactive<Record<keyof WorkspaceLimits, boolean>>({
  members: false,
  problems: false,
  storage_bytes: false,
  submissions_per_minute: false,
});

// 单一真相源的输入缓冲字符串：防止重渲染将用户非法输入覆盖回旧值
const inputStrings = reactive<Record<keyof WorkspaceLimits, string>>({
  members: '',
  problems: '',
  storage_bytes: '',
  submissions_per_minute: '',
});

const storageUnit = ref<StorageUnit>('gib');

// 首次读取或保存后配置作为基线，用于判断是否有真实草稿改变
const baseline = ref<WorkspaceLimits>({ ...model.value });

function formatLimit(key: keyof WorkspaceLimits, val: number | null | undefined): string {
  if (val == null) return '不限制';
  if (val === 0) return '0 (禁止)';
  if (key === 'storage_bytes') {
    if (val >= GIB && val % GIB === 0) return `${val / GIB} GiB (${val.toLocaleString()} 字节)`;
    if (val >= GIB) return `${(val / GIB).toFixed(2)} GiB (${val.toLocaleString()} 字节)`;
    if (val >= MIB) return `${(val / MIB).toFixed(2)} MiB (${val.toLocaleString()} 字节)`;
    return `${val.toLocaleString()} 字节`;
  }
  const unit = WORKSPACE_LIMIT_FIELDS.find((f) => f.key === key)?.unit ?? '';
  return `${val.toLocaleString()} ${unit}`;
}

const fieldErrors = reactive<Record<keyof WorkspaceLimits, string>>({
  members: '',
  problems: '',
  storage_bytes: '',
  submissions_per_minute: '',
});

function syncFromModel(val: WorkspaceLimits) {
  baseline.value = { ...val };
  for (const field of WORKSPACE_LIMIT_FIELDS) {
    const key = field.key;
    const v = val[key];
    fieldErrors[key] = '';
    if (v !== null && v !== undefined) {
      isCustom[key] = true;
      if (key === 'storage_bytes') {
        const u = bestStorageUnit(v);
        storageUnit.value = u;
        inputStrings.storage_bytes = String(bytesToUnitValue(v, u));
      } else {
        inputStrings[key] = String(v);
      }
    } else {
      isCustom[key] = false;
      inputStrings[key] = '';
    }
  }
}

// 仅在父组件替换 model.value 整个对象引用时重建输入/错误/基线（初始也执行）
watch(
  () => model.value,
  (newVal) => {
    if (newVal) {
      syncFromModel(newVal);
    }
  },
  { immediate: true },
);

function validateNonStorageField(key: keyof WorkspaceLimits) {
  if (!isCustom[key] || key === 'storage_bytes') {
    fieldErrors[key] = '';
    return;
  }
  const field = WORKSPACE_LIMIT_FIELDS.find((f) => f.key === key);
  const raw = inputStrings[key];
  if (raw === '' || raw === null || raw === undefined) {
    fieldErrors[key] = `请填写${field?.label ?? ''}上限数值`;
    return;
  }
  const num = Number(raw);
  if (isNaN(num) || num < 0) {
    fieldErrors[key] = `${field?.label ?? ''}上限必须大于或等于 0`;
  } else if (!Number.isInteger(num)) {
    fieldErrors[key] = `${field?.label ?? ''}上限必须为整数`;
  } else if (field && num > field.max) {
    fieldErrors[key] = `${field.label}上限不能超过 ${field.max.toLocaleString()}`;
  } else {
    fieldErrors[key] = '';
    model.value[key] = num;
  }
}

function validateStorageField() {
  if (!isCustom.storage_bytes) {
    fieldErrors.storage_bytes = '';
    return;
  }
  const res = validateStorageInput(inputStrings.storage_bytes, storageUnit.value);
  if (!res.valid) {
    fieldErrors.storage_bytes = res.error ?? '存储上限数值无效';
  } else {
    fieldErrors.storage_bytes = '';
    model.value.storage_bytes = res.bytes ?? 0;
  }
}

const isValid = computed(() => {
  return WORKSPACE_LIMIT_FIELDS.every((f) => {
    if (!isCustom[f.key]) return true;
    return !fieldErrors[f.key] && inputStrings[f.key] !== '';
  });
});

watch(
  isValid,
  (valid) => {
    emit('valid', valid);
  },
  { immediate: true },
);

function onModeChange(key: keyof WorkspaceLimits, mode: unknown) {
  if (mode === 'custom') {
    isCustom[key] = true;
    const eff = props.effective?.[key];
    const cap = props.caps?.[key];
    const initialVal = (typeof eff === 'number' && Number.isFinite(eff) && eff >= 0)
      ? eff
      : (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0)
      ? cap
      : null;

    if (key === 'storage_bytes') {
      if (initialVal !== null) {
        const u = bestStorageUnit(initialVal);
        storageUnit.value = u;
        inputStrings.storage_bytes = String(bytesToUnitValue(initialVal, u));
        model.value.storage_bytes = initialVal;
      } else {
        inputStrings.storage_bytes = '';
        model.value.storage_bytes = null;
      }
      validateStorageField();
    } else {
      if (initialVal !== null) {
        inputStrings[key] = String(initialVal);
        model.value[key] = initialVal;
      } else {
        inputStrings[key] = '';
        model.value[key] = null;
      }
      validateNonStorageField(key);
    }
  } else {
    isCustom[key] = false;
    inputStrings[key] = '';
    fieldErrors[key] = '';
    model.value[key] = null;
  }
}

function onInput(key: keyof WorkspaceLimits, val: unknown) {
  inputStrings[key] = String(val ?? '');
  if (key === 'storage_bytes') {
    validateStorageField();
  } else {
    validateNonStorageField(key);
  }
}

function onStorageUnitChange(newUnit: unknown) {
  const targetUnit = newUnit as StorageUnit;
  const currentBytes = model.value.storage_bytes;
  if (currentBytes !== null && currentBytes !== undefined && currentBytes >= 0) {
    if (canLosslesslyConvert(currentBytes, targetUnit)) {
      storageUnit.value = targetUnit;
      inputStrings.storage_bytes = String(bytesToUnitValue(currentBytes, targetUnit));
      fieldErrors.storage_bytes = '';
    } else {
      // 无法无损转换：保留原有 bytes，展示错误并引导用户输入新单位下的整数
      storageUnit.value = targetUnit;
      inputStrings.storage_bytes = '';
      fieldErrors.storage_bytes = `原存储字节数 (${currentBytes.toLocaleString()} 字节) 无法无损转换为 ${targetUnit.toUpperCase()}，请输入新的整数上限，或切换回字节单位保留原值`;
    }
  } else {
    storageUnit.value = targetUnit;
    validateStorageField();
  }
}

function setStoragePreset(size: number) {
  storageUnit.value = 'gib';
  inputStrings.storage_bytes = String(size);
  fieldErrors.storage_bytes = '';
  model.value.storage_bytes = size * GIB;
}

function hasDraftChange(key: keyof WorkspaceLimits): boolean {
  const isNowCustom = isCustom[key];
  const wasCustom = baseline.value[key] !== null && baseline.value[key] !== undefined;
  if (isNowCustom !== wasCustom) return true;
  if (isNowCustom) {
    return model.value[key] !== baseline.value[key];
  }
  return false;
}

function getProjected(key: keyof WorkspaceLimits): string {
  if (!isCustom[key]) {
    if (props.mode === 'domain_limits' && props.caps) {
      const cap = props.caps[key];
      return cap != null ? formatLimit(key, cap) : '不限制';
    }
    return '不限制';
  }
  if (fieldErrors[key] || inputStrings[key] === '' || model.value[key] == null) {
    return '待填写';
  }
  const current = model.value[key]!;
  if (props.mode === 'domain_limits' && props.caps?.[key] != null) {
    const effectiveVal = Math.min(current, props.caps[key]!);
    return formatLimit(key, effectiveVal);
  }
  return formatLimit(key, current);
}

function customLabel(key: keyof WorkspaceLimits): string {
  switch (props.mode) {
    case 'instance_caps':
      return '设置实例上限';
    case 'instance_defaults':
      return '设置新域默认上限';
    case 'domain_limits':
    default:
      return '设置本域上限';
  }
}

function unlimitedLabel(key: keyof WorkspaceLimits): string {
  switch (props.mode) {
    case 'instance_caps':
      return '不设实例上限';
    case 'instance_defaults':
      return '默认不单独限额';
    case 'domain_limits':
    default:
      return '使用实例上限';
  }
}

function getModeOptions(key: keyof WorkspaceLimits) {
  return [
    { label: unlimitedLabel(key), value: 'inherit' },
    { label: customLabel(key), value: 'custom' },
  ];
}
</script>

<template>
  <div class="grid gap-5 sm:grid-cols-2">
    <div v-for="field in WORKSPACE_LIMIT_FIELDS" :key="field.key" class="space-y-3 rounded border border-border bg-bg-panel p-3">
      <div>
        <span class="text-sm font-medium text-text">{{ field.label }}</span>
        <div class="mt-1.5">
          <USelect
            :model-value="isCustom[field.key] ? 'custom' : 'inherit'"
            :items="getModeOptions(field.key)"
            :disabled="disabled"
            :aria-label="`${field.label}额度模式`"
            class="w-full"
            @update:model-value="onModeChange(field.key, $event)"
          />
        </div>
      </div>

      <div v-if="isCustom[field.key]" class="space-y-2 pt-1 border-t border-border/60">
        <!-- 存储空间专属：单位选择 (GiB / MiB / 字节) + 整数输入 + 常用预设 -->
        <div v-if="field.key === 'storage_bytes'" class="space-y-2">
          <div class="flex items-center gap-2">
            <UInput
              :model-value="inputStrings.storage_bytes"
              type="number"
              inputmode="numeric"
              step="1"
              :min="0"
              :max="field.max"
              :disabled="disabled"
              :aria-label="`${field.label}上限`"
              placeholder="输入数值"
              class="w-full max-w-[200px] font-mono text-xs"
              @update:model-value="onInput('storage_bytes', $event)"
            />
            <USelect
              :model-value="storageUnit"
              :items="STORAGE_UNIT_OPTIONS"
              :disabled="disabled"
              aria-label="存储单位"
              class="w-24 shrink-0"
              @update:model-value="onStorageUnitChange"
            />
            <div v-if="!disabled" class="hidden sm:flex flex-wrap gap-1 ml-auto">
              <UButton
                v-for="size in STORAGE_PRESET_GIB"
                :key="size"
                size="xs"
                variant="outline"
                color="neutral"
                @click="setStoragePreset(size)"
              >
                {{ size }} GiB
              </UButton>
            </div>
          </div>

          <div v-if="!disabled" class="flex sm:hidden flex-wrap gap-1">
            <UButton
              v-for="size in STORAGE_PRESET_GIB"
              :key="size"
              size="xs"
              variant="outline"
              color="neutral"
              @click="setStoragePreset(size)"
            >
              {{ size }} GiB
            </UButton>
          </div>

          <p class="text-xs text-text-secondary tabular-nums">
            当前换算：{{ formatLimit('storage_bytes', model.storage_bytes) }}
          </p>
        </div>

        <!-- 其他通用整数上限 -->
        <div v-else class="flex items-center gap-2">
          <UInput
            :model-value="inputStrings[field.key]"
            type="number"
            inputmode="numeric"
            step="1"
            :min="0"
            :max="field.max"
            :disabled="disabled"
            :aria-label="`${field.label}上限`"
            class="w-full max-w-[200px]"
            @update:model-value="onInput(field.key, $event)"
          />
          <span class="text-xs text-text-muted shrink-0">{{ field.unit }}</span>
        </div>

        <p v-if="fieldErrors[field.key]" class="text-xs text-error-text" role="alert">
          {{ fieldErrors[field.key] }}
        </p>

        <p v-if="model[field.key] === 0" class="text-xs text-amber-600">
          0 表示禁止对应新增或调用，但保留历史数据与已有配置。
        </p>
      </div>

      <div class="space-y-1.5 pt-2 border-t border-border/60 text-xs tabular-nums">
        <div v-if="effective" class="flex items-center justify-between">
          <span class="text-text-secondary">当前已保存有效值：</span>
          <span class="font-semibold text-text">{{ effective[field.key] != null ? formatLimit(field.key, effective[field.key]) : '不限制' }}</span>
        </div>
        <div v-if="caps" class="flex items-center justify-between text-text-muted">
          <span>实例上限：</span>
          <span class="text-text-secondary">{{ caps[field.key] != null ? formatLimit(field.key, caps[field.key]) : '不设上限' }}</span>
        </div>
        <!-- 只有真实的草稿改变时才显示保存后预计生效 -->
        <div
          v-if="hasDraftChange(field.key)"
          class="flex items-center justify-between rounded px-2 py-1 bg-primary-bg/40 font-medium text-primary transition-colors"
        >
          <span>保存后预计生效：</span>
          <span class="font-semibold text-primary">
            {{ getProjected(field.key) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
