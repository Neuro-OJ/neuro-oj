import Swal from "sweetalert2"

interface DialogMethods {
  confirm(message: string, options?: { title?: string; danger?: boolean; confirmText?: string; cancelText?: string }): Promise<boolean>
  alert(message: string, options?: { title?: string }): Promise<void>
  prompt(message: string, options?: { title?: string; placeholder?: string; confirmText?: string }): Promise<string | null>
}

export function useDialog(): { dialog: DialogMethods } {
  const dialog: DialogMethods = {
    async confirm(message, options = {}) {
      if (import.meta.server) return false
      const result = await Swal.fire({
        title: options.title ?? "确认操作", text: message, icon: "question",
        showCancelButton: true, reverseButtons: true,
        confirmButtonText: options.confirmText ?? "确认",
        cancelButtonText: options.cancelText ?? "取消",
        confirmButtonColor: options.danger ? "#ef4444" : undefined,
      })
      return result.isConfirmed
    },
    async alert(message, options = {}) {
      if (import.meta.server) return
      await Swal.fire({ title: options.title ?? "提示", text: message, icon: "info", confirmButtonText: "确定" })
    },
    async prompt(message, options = {}) {
      if (import.meta.server) return null
      const result = await Swal.fire({
        title: options.title ?? "输入", text: message, input: "text",
        inputPlaceholder: options.placeholder, showCancelButton: true, reverseButtons: true,
        confirmButtonText: options.confirmText ?? "确认", cancelButtonText: "取消",
      })
      return result.value ?? null
    },
  }
  return { dialog }
}
