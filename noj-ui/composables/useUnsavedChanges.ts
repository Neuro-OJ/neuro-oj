import { type MaybeRefOrGetter, onMounted, onUnmounted, toValue } from 'vue';

/** 路由离开和浏览器刷新都保护尚未保存的表单；成功保存后由调用方更新基线。 */
export function useUnsavedChanges(dirty: MaybeRefOrGetter<boolean>) {
  const { dialog } = useDialog();
  const confirmLeave = async () =>
    !toValue(dirty) || await dialog.confirm('修改尚未保存，确定离开此页面？', { title: '未保存的修改' });
  onBeforeRouteLeave(confirmLeave);
  onBeforeRouteUpdate(confirmLeave);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!toValue(dirty)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  onMounted(() => globalThis.addEventListener('beforeunload', beforeUnload));
  onUnmounted(() => globalThis.removeEventListener('beforeunload', beforeUnload));
}
