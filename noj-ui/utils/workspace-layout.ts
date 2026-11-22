/**
 * 工作空间与面包屑宽度的单一事实来源。
 *
 * 保证 `layouts/workspace.vue` 与 `components/layout/BreadcrumbNav.vue`
 * 在所有断点下使用完全一致的最大宽度，避免面包屑与页面标题左边缘错位。
 */
export type WorkspaceWidthKey = 'home' | 'library' | 'problem' | 'workspace' | 'default';

export interface WorkspaceWidthSpec {
  maxWidth: string;
  className: string;
}

export const WORKSPACE_WIDTH_MAP: Record<WorkspaceWidthKey, WorkspaceWidthSpec> = {
  home: { maxWidth: '1320px', className: 'max-w-[1320px]' },
  library: { maxWidth: '1040px', className: 'max-w-[1040px]' },
  problem: { maxWidth: '1280px', className: 'max-w-[1280px]' },
  workspace: { maxWidth: '1440px', className: 'max-w-[1440px]' },
  default: { maxWidth: '1152px', className: 'max-w-6xl' },
};

/**
 * 从页面 meta 解析工作区容器宽度规格。
 * 兼容历史 `problemWorkspace: true` 标记与新增 `workspaceWidth` 枚举。
 */
export function resolveWorkspaceWidth(meta: Record<string, unknown> | undefined): WorkspaceWidthSpec {
  const key = meta?.workspaceWidth;
  if (typeof key === 'string' && key in WORKSPACE_WIDTH_MAP) {
    return WORKSPACE_WIDTH_MAP[key as WorkspaceWidthKey];
  }
  if (meta?.problemWorkspace) {
    return WORKSPACE_WIDTH_MAP.workspace;
  }
  return WORKSPACE_WIDTH_MAP.default;
}
