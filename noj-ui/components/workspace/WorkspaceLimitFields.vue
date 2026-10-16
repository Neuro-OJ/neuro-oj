<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { WORKSPACE_LIMIT_FIELDS } from '~/utils/instance-governance';
import type { WorkspaceLimits } from '~/utils/workspace';

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

const GIB = 1073741824;
const MIB = 1048576;

const isCustom = reactive<Record<keyof WorkspaceLimits, boolean>>({
  members: false,
  problems: false,
  storage_bytes: false,
  submissions_per_minute: false,
});

const rawInputs = reactive<Record<keyof WorkspaceLimits, number | string | null>>({
  members: null,
  problems: null,
  storage_bytes: null,
  submissions_per_minute: null,
});

function syncFromModel() {
  for (const field of WORKSPACE_LIMIT_FIELDS) {
    const key = field.key;
    const val = model.value[key];
    if (val !== null && val !== undefined) {
      isCustom[key] = true;
      rawInputs[key] = val;
    } else {
      isCustom[key] = false;
      rawInputs[key] = null;
      model.value[key] = null;
    }
  }
}
syncFromModel();

watch(
  () => ({ ...model.value }),
  (newVal) => {
    for (const field of WORKSPACE_LIMIT_FIELDS) {
      const key = field.key;
      const val = newVal[key];
      if (val !== null && val !== undefined) {
        if (!isCustom[key] || rawInputs[key] !== val) {
          isCustom[key] = true;
          rawInputs[key] = val;
        }
      } else if (isCustom[key] && rawInputs[key] !== '') {
        isCustom[key] = false;
        rawInputs[key] = null;
      }
    }
  },
  { deep: true },
);

const fieldErrors = computed<Record<keyof WorkspaceLimits, string>>(() => {
  const errs: Record<keyof WorkspaceLimits, string> = {
    members: '',
    problems: '',
    storage_bytes: '',
    submissions_per_minute: '',
  };
  for (const field of WORKSPACE_LIMIT_FIELDS) {
    const key = field.key;
    if (isCustom[key]) {
      const raw = rawInputs[key];
      if (raw === '' || raw === null || raw === undefined) {
        errs[key] = `请填写${field.label}上限数值`;
      } else {
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (isNaN(num) || num < 0) {
          errs[key] = `${field.label}上限必须大于或等于 0`;
        } else if (!Number.isInteger(num)) {
          errs[key] = `${field.label}上限必须为整数`;
        } else if (num > field.max) {
          errs[key] = `${field.label}上限不能超过 ${field.max.toLocaleString()}`;
        }
      }
    }
  }
  return errs;
});

const isValid = computed(() =>
  Object.values(fieldErrors.value).every((err) => !err)
);

watch(isValid, (valid) => {
  emit('valid', valid);
}, { immediate: true });

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

function getProjected(key: keyof WorkspaceLimits): string {
  if (!isCustom[key]) {
    if (props.mode === 'domain_limits' && props.caps) {
      const cap = props.caps[key];
      return cap != null ? formatLimit(key, cap) : '不限制';
    }
    return '不限制';
  }
  if (rawInputs[key] === '' || rawInputs[key] === null || rawInputs[key] === undefined) {
    return '待填写';
  }
  const current = typeof rawInputs[key] === 'number' ? (rawInputs[key] as number) : Number(rawInputs[key]);
  if (typeof current !== 'number' || isNaN(current) || !Number.isInteger(current) || current < 0) return '待填写';
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

function onModeChange(key: keyof WorkspaceLimits, mode: unknown) {
  onToggle(key, mode === 'custom');
}

function onToggle(key: keyof WorkspaceLimits, custom: boolean) {
  if (!custom) {
    isCustom[key] = false;
    rawInputs[key] = null;
    model.value[key] = null;
  } else {
    isCustom[key] = true;
    const eff = props.effective?.[key];
    if (typeof eff === 'number' && Number.isFinite(eff) && eff >= 0) {
      rawInputs[key] = eff;
      model.value[key] = eff;
    } else if (typeof props.caps?.[key] === 'number' && Number.isFinite(props.caps[key]) && props.caps[key]! >= 0) {
      rawInputs[key] = props.caps[key]!;
      model.value[key] = props.caps[key]!;
    } else {
      rawInputs[key] = '';
    }
  }
}

function onNumberInput(key: keyof WorkspaceLimits, val: unknown) {
  if (val === '' || val === null || val === undefined) {
    rawInputs[key] = '';
    return;
  }
  const str = String(val).trim();
  if (str === '') {
    rawInputs[key] = '';
    return;
  }
  const num = Number(str);
  if (isNaN(num)) {
    rawInputs[key] = str;
    return;
  }
  rawInputs[key] = num;
  const field = WORKSPACE_LIMIT_FIELDS.find((f) => f.key === key);
  const max = field?.max ?? Number.MAX_SAFE_INTEGER;
  if (Number.isInteger(num) && num >= 0 && num <= max) {
    model.value[key] = num;
  }
}

function setStorageQuick(gib: number) {
  const bytes = gib * GIB;
  rawInputs.storage_bytes = bytes;
  model.value.storage_bytes = bytes;
}

const storageGibInput = ref<number | string>('');

watch(
  () => rawInputs.storage_bytes,
  (val) => {
    if (typeof val === 'number' && val >= 0) {
      storageGibInput.value = (val / GIB).toFixed(2).replace(/\.00$/, '');
    } else {
      storageGibInput.value = '';
    }
  },
  { immediate: true },
);

function onGibInput(val: unknown) {
  if (val === '' || val === null || val === undefined) {
    storageGibInput.value = '';
    onNumberInput('storage_bytes', '');
    return;
  }
  const num = Number(val);
  if (isNaN(num) || num < 0) return;
  const bytes = Math.round(num * GIB);
  rawInputs.storage_bytes = bytes;
  model.value.storage_bytes = bytes;
}

function hasProjectedChange(key: keyof WorkspaceLimits): boolean {
  const proj = getProjected(key);
  const eff = props.effective?.[key] != null ? formatLimit(key, props.effective[key]) : '不限制';
  return proj !== eff && proj !== '待填写';
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
        <div v-if="field.key === 'storage_bytes'" class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-xs text-text-secondary shrink-0">容量输入：</span>
            <UInput
              :model-value="String(storageGibInput)"
              type="number"
              step="any"
              min="0"
              :disabled="disabled"
              aria-label="存储容量GiB"
              placeholder="数值"
              class="w-24 font-mono text-xs"
              @update:model-value="onGibInput"
            />
            <span class="text-xs text-text-muted shrink-0">GiB</span>
            <div v-if="!disabled" class="flex flex-wrap gap-1 ml-auto">
              <UButton v-for="size in [1, 5, 20, 100, 256]" :key="size" size="xs" variant="outline" color="neutral" @click="setStorageQuick(size)">
                {{ size }} GiB
              </UButton>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-xs text-text-muted shrink-0">精确字节：</span>
            <UInput
              :model-value="String(rawInputs[field.key] ?? '')"
              type="number"
              inputmode="numeric"
              step="1"
              :min="0"
              :max="field.max"
              :disabled="disabled"
              :aria-label="`${field.label}上限`"
              class="w-full max-w-[200px] font-mono text-xs"
              @update:model-value="onNumberInput(field.key, $event)"
            />
            <span class="text-xs text-text-muted shrink-0">{{ field.unit }}</span>
          </div>

          <p class="text-xs text-text-secondary tabular-nums">
            当前输入换算：{{ formatLimit('storage_bytes', typeof rawInputs.storage_bytes === 'number' ? rawInputs.storage_bytes : model.storage_bytes) }}
          </p>
        </div>

        <div v-else class="flex items-center gap-2">
          <UInput
            :model-value="String(rawInputs[field.key] ?? '')"
            type="number"
            inputmode="numeric"
            step="1"
            :min="0"
            :max="field.max"
            :disabled="disabled"
            :aria-label="`${field.label}上限`"
            class="w-full max-w-[200px]"
            @update:model-value="onNumberInput(field.key, $event)"
          />
          <span class="text-xs text-text-muted shrink-0">{{ field.unit }}</span>
        </div>

        <p v-if="fieldErrors[field.key]" class="text-xs text-error-text" role="alert">
          {{ fieldErrors[field.key] }}
        </p>

        <p v-if="rawInputs[field.key] === 0 || model[field.key] === 0" class="text-xs text-amber-600">
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
        <div
          class="flex items-center justify-between rounded px-2 py-1 transition-colors"
          :class="hasProjectedChange(field.key) ? 'bg-primary-bg/40 font-medium text-primary' : 'text-text-muted'"
        >
          <span>保存后预计生效：</span>
          <span :class="hasProjectedChange(field.key) ? 'font-semibold text-primary' : 'text-text-secondary'">
            {{ getProjected(field.key) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
