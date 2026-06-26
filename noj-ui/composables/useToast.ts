import Swal from "sweetalert2"

const ToastSwal = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timerProgressBar: false,
  didOpen: (toast) => {
    toast.addEventListener("mouseenter", () => Swal.stopTimer())
    toast.addEventListener("mouseleave", () => Swal.resumeTimer())
  },
})

interface ToastMethods {
  success(message: string): void
  error(message: string): void
  warn(message: string): void
  info(message: string): void
}

export function useToast(): { toast: ToastMethods } {
  const toast: ToastMethods = {
    success: (msg) => { ToastSwal.fire({ icon: "success", title: msg, timer: 3000 }) },
    error: (msg) => { ToastSwal.fire({ icon: "error", title: msg, timer: 5000 }) },
    warn: (msg) => { ToastSwal.fire({ icon: "warning", title: msg, timer: 3000 }) },
    info: (msg) => { ToastSwal.fire({ icon: "info", title: msg, timer: 2000 }) },
  }
  return { toast }
}
