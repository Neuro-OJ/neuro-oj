import Swal from 'sweetalert2';

const ToastSwal = Swal.mixin({
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timerProgressBar: false,
  didOpen: (toast) => {
    toast.addEventListener('mouseenter', () => Swal.stopTimer());
    toast.addEventListener('mouseleave', () => Swal.resumeTimer());
  },
});

interface ToastMethods {
  success(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface UseToastResult {
  toast: ToastMethods;
  showToast(type: ToastType, message: string): void;
}

export function useToast(): UseToastResult {
  const toast: ToastMethods = {
    success: (msg) => {
      ToastSwal.fire({ icon: 'success', title: msg, timer: 3000 });
    },
    error: (msg) => {
      ToastSwal.fire({ icon: 'error', title: msg, timer: 5000 });
    },
    warn: (msg) => {
      ToastSwal.fire({ icon: 'warning', title: msg, timer: 3000 });
    },
    info: (msg) => {
      ToastSwal.fire({ icon: 'info', title: msg, timer: 2000 });
    },
  };

  function showToast(type: ToastType, message: string) {
    if (type === 'warning') {
      toast.warn(message);
      return;
    }
    toast[type](message);
  }

  return { toast, showToast };
}
