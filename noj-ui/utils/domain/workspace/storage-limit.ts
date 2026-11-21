export type StorageUnit = 'gib' | 'mib' | 'bytes';

export const GIB = 1073741824;
export const MIB = 1048576;

export const STORAGE_UNIT_MULTIPLIER: Record<StorageUnit, number> = {
  gib: GIB,
  mib: MIB,
  bytes: 1,
};

export const STORAGE_UNIT_OPTIONS = [
  { label: 'GiB', value: 'gib' as StorageUnit },
  { label: 'MiB', value: 'mib' as StorageUnit },
  { label: '字节', value: 'bytes' as StorageUnit },
];

export const STORAGE_PRESET_GIB = [1, 5, 20, 100, 256] as const;

export function bestStorageUnit(bytes: number | null | undefined): StorageUnit {
  if (bytes === null || bytes === undefined || bytes === 0) {
    return 'gib';
  }
  if (bytes > 0 && bytes % GIB === 0) {
    return 'gib';
  }
  if (bytes > 0 && bytes % MIB === 0) {
    return 'mib';
  }
  return 'bytes';
}

export function canLosslesslyConvert(bytes: number, targetUnit: StorageUnit): boolean {
  if (bytes === 0) return true;
  return bytes % STORAGE_UNIT_MULTIPLIER[targetUnit] === 0;
}

export function bytesToUnitValue(bytes: number, unit: StorageUnit): number {
  return bytes / STORAGE_UNIT_MULTIPLIER[unit];
}

export function unitValueToBytes(val: number, unit: StorageUnit): number {
  return Math.round(val * STORAGE_UNIT_MULTIPLIER[unit]);
}

export function validateStorageInput(
  rawInput: string | number | null | undefined,
  unit: StorageUnit,
): { valid: boolean; bytes?: number; error?: string } {
  if (rawInput === '' || rawInput === null || rawInput === undefined) {
    return { valid: false, error: '请填写存储上限数值' };
  }
  const str = String(rawInput).trim();
  if (str === '') {
    return { valid: false, error: '请填写存储上限数值' };
  }
  const num = Number(str);
  if (isNaN(num)) {
    return { valid: false, error: '存储上限必须为有效数字' };
  }
  if (num < 0) {
    return { valid: false, error: '存储上限必须大于或等于 0' };
  }
  if (!Number.isInteger(num)) {
    return { valid: false, error: '存储上限必须为整数' };
  }
  const bytes = num * STORAGE_UNIT_MULTIPLIER[unit];
  if (bytes > Number.MAX_SAFE_INTEGER) {
    return {
      valid: false,
      error: `存储上限不能超过 ${Number.MAX_SAFE_INTEGER.toLocaleString()} 字节`,
    };
  }
  return { valid: true, bytes };
}
