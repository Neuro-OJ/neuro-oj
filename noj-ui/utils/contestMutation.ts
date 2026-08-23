export interface ContestMutationOptions {
  isSaving: () => boolean;
  setSaving: (saving: boolean) => void;
  save: () => Promise<void>;
  /** 保存请求出现网络异常时，确认服务端是否已经完成写入。 */
  recover?: (error: unknown) => Promise<boolean>;
  onSaved: () => void;
  refresh: () => Promise<boolean>;
  onRefreshFailed: () => void;
}

/**
 * 执行竞赛保存流程，区分保存结果与保存后的列表刷新结果。
 *
 * 保存请求成功后，刷新失败不能回到保存失败分支，也不能触发第二次保存。
 */
export async function runContestMutation(options: ContestMutationOptions): Promise<boolean> {
  if (options.isSaving()) return false;

  // 在第一次 await 之前设置状态，保证同一事件循环内的重复调用也只能进入一次。
  options.setSaving(true);
  try {
    try {
      await options.save();
    } catch (error) {
      const recovered = options.recover ? await options.recover(error) : false;
      if (!recovered) throw error;
    }
    options.onSaved();

    let refreshed = false;
    try {
      refreshed = await options.refresh();
    } catch {
      // 列表刷新属于保存后的补偿动作，不能把已成功的保存重新判定为失败。
    }
    if (!refreshed) options.onRefreshFailed();
    return true;
  } finally {
    options.setSaving(false);
  }
}
